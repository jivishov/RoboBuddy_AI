(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const DEFAULT_BAUD = 9600;
  const DEFAULT_TIMEOUT_MS = 7000;
  const MOTION_COMMAND_TIMEOUT_MS = 15000;
  const HOME_COMMAND_TIMEOUT_MS = 30000;
  const MOTION_DELAY_GRACE_MS = 5000;
  const REALTIME_CONTROL_TIMEOUT_MS = 2500;
  const MOTION_ACK_PREDICATE = (line) => line === "OK" || line === "STOPPED";

  class SerialManager extends EventTarget {
    constructor(options = {}) {
      super();
      this.baudRate = options.baudRate || DEFAULT_BAUD;
      this.port = null;
      this.reader = null;
      this.writer = null;
      this.encoder = new TextEncoder();
      this.decoder = new TextDecoder();
      this.connected = false;

      this._readBuffer = "";
      this._lineWaiters = [];
      this._commandQueue = Promise.resolve();
      this._queueDepth = 0;
      this._inFlightCommand = "";
      this._autoReconnectEnabled = true;
      this._isReconnecting = false;
      this._lastConnectRequestFailed = false;
      this._recentLines = [];
      this._maxRecentLines = 60;
      this._lineSeq = 0;
      this._transportKind = "serial";
      this._firmwareProfile = null;
      this._realtimeControl = null;

      this._boundDisconnectHandler = (event) => {
        if (this.port && event.port === this.port) {
          this._onPhysicalDisconnect("Device disconnected");
        }
      };
    }

    supportsWebSerial() {
      return typeof navigator !== "undefined" && "serial" in navigator;
    }

    isConnected() {
      return this.connected;
    }

    getTransportKind() {
      return this._transportKind;
    }

    getTransportLabel() {
      if (this._transportKind === "usb") {
        return "USB Serial";
      }
      if (this._transportKind === "bluetooth") {
        return "Bluetooth Serial";
      }
      return "Serial";
    }

    getQueueSnapshot() {
      return {
        pending: Math.max(0, Number(this._queueDepth) || 0),
        inFlight: this._inFlightCommand || "",
        lineWaiters: this._lineWaiters.length
      };
    }

    async connect() {
      if (!this.supportsWebSerial()) {
        throw new Error("Web Serial API is not available in this browser.");
      }

      if (this.connected) {
        return;
      }

      this._lastConnectRequestFailed = false;
      this.port = await navigator.serial.requestPort();
      await this._openPort(this.port);
    }

    async disconnect() {
      this._autoReconnectEnabled = false;
      await this._closePort("Disconnected");
    }

    async reconnect() {
      if (!this.port) {
        throw new Error("No previous port available to reconnect.");
      }

      await this._openPort(this.port);
    }

    async _openPort(port) {
      try {
        await port.open({ baudRate: this.baudRate });
      } catch (error) {
        this._lastConnectRequestFailed = true;
        throw error;
      }

      this.reader = port.readable.getReader();
      this.writer = port.writable.getWriter();
      this.connected = true;
      this._readBuffer = "";
      this._recentLines = [];
      this._lineSeq = 0;
      this._queueDepth = 0;
      this._inFlightCommand = "";
      this._firmwareProfile = null;
      this._realtimeControl = null;
      this._autoReconnectEnabled = true;
      this._transportKind = detectTransportKind(port);

      navigator.serial.addEventListener("disconnect", this._boundDisconnectHandler);
      this._dispatchStatus(`Connected (${this.getTransportLabel()})`, true);
      this._dispatchQueueDebug();
      this._startReadLoop();
    }

    async _closePort(reason) {
      this.connected = false;
      this._rejectLineWaiters(new Error(reason || "Port closed"));
      this._dispatchStatus(reason || "Disconnected", false);
      this._queueDepth = 0;
      this._inFlightCommand = "";
      this._dispatchQueueDebug();

      navigator.serial.removeEventListener("disconnect", this._boundDisconnectHandler);

      if (this.reader) {
        try {
          await this.reader.cancel();
        } catch (error) {
          // Ignore cancellation errors.
        }
        try {
          this.reader.releaseLock();
        } catch (error) {
          // Ignore release errors.
        }
        this.reader = null;
      }

      if (this.writer) {
        try {
          this.writer.releaseLock();
        } catch (error) {
          // Ignore release errors.
        }
        this.writer = null;
      }

      if (this.port) {
        try {
          await this.port.close();
        } catch (error) {
          // Ignore close errors when physically unplugged.
        }
      }

      this._transportKind = "serial";
      this._firmwareProfile = null;
      this._realtimeControl = null;
    }

    _onPhysicalDisconnect(reason) {
      this.connected = false;
      this._rejectLineWaiters(new Error(reason));
      this._dispatchStatus(reason, false);
      this._attemptAutoReconnect();
    }

    _attemptAutoReconnect() {
      if (!this._autoReconnectEnabled || this._isReconnecting || !this.port) {
        return;
      }

      this._isReconnecting = true;

      const tryReconnect = async () => {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await delay(800 * attempt);
          try {
            await this._openPort(this.port);
            this._dispatchStatus("Reconnected", true);
            this._isReconnecting = false;
            return;
          } catch (error) {
            this._dispatchStatus(`Reconnect attempt ${attempt} failed`, false);
          }
        }

        this._isReconnecting = false;
      };

      void tryReconnect();
    }

    _startReadLoop() {
      const loop = async () => {
        while (this.reader && this.connected) {
          let result;
          try {
            result = await this.reader.read();
          } catch (error) {
            this._onPhysicalDisconnect("Read failed");
            return;
          }

          if (!result || result.done) {
            if (this.connected) {
              this._onPhysicalDisconnect("Serial stream closed");
            }
            return;
          }

          const chunk = this.decoder.decode(result.value, { stream: true });
          this._consumeText(chunk);
        }
      };

      void loop();
    }

    _consumeText(text) {
      this._readBuffer += text;

      while (true) {
        const newlineIndex = this._readBuffer.search(/[\r\n]/);
        if (newlineIndex < 0) {
          break;
        }

        const line = this._readBuffer.slice(0, newlineIndex).trim();
        const rest = this._readBuffer.slice(newlineIndex + 1);
        this._readBuffer = rest.replace(/^[\r\n]+/, "");

        if (line.length > 0) {
          this._onLine(line);
        }
      }
    }

    _rememberLine(line) {
      this._lineSeq += 1;
      const entry = { id: this._lineSeq, line };
      this._recentLines.push(entry);
      if (this._recentLines.length > this._maxRecentLines) {
        this._recentLines.shift();
      }
      return entry;
    }

    _onLine(line) {
      const lineEntry = this._rememberLine(line);
      this.dispatchEvent(new CustomEvent("line", { detail: { line } }));

      if (line.startsWith("P")) {
        const parsed = parsePositions(line);
        if (parsed) {
          this.dispatchEvent(new CustomEvent("positions", { detail: { angles: parsed } }));
        }
      }

      if (line === "PAUSED") {
        this._pausePauseAwareWaiters();
      } else if (line === "RESUMED") {
        this._resumePauseAwareWaiters();
      }

      const remaining = [];
      for (const waiter of this._lineWaiters) {
        if (lineEntry.id <= waiter.afterId) {
          remaining.push(waiter);
          continue;
        }
        try {
          if (waiter.predicate(line)) {
            this._clearWaiterTimer(waiter);
            waiter.resolve(line);
            continue;
          }
        } catch (error) {
          this._clearWaiterTimer(waiter);
          waiter.reject(error);
          continue;
        }
        remaining.push(waiter);
      }
      this._lineWaiters = remaining;
    }

    _rejectLineWaiters(error) {
      for (const waiter of this._lineWaiters) {
        this._clearWaiterTimer(waiter);
        waiter.reject(error);
      }
      this._lineWaiters = [];
    }

    _nowMs() {
      if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return performance.now();
      }
      return Date.now();
    }

    _clearWaiterTimer(waiter) {
      if (!waiter || !waiter.timeoutId) {
        return;
      }
      window.clearTimeout(waiter.timeoutId);
      waiter.timeoutId = null;
    }

    _pausePauseAwareWaiters() {
      const now = this._nowMs();
      for (const waiter of this._lineWaiters) {
        if (!waiter.pauseAware || waiter.paused) {
          continue;
        }
        this._clearWaiterTimer(waiter);
        const elapsed = Math.max(0, now - waiter.timerStartedAt);
        waiter.remainingMs = Math.max(0, waiter.remainingMs - elapsed);
        waiter.paused = true;
      }
    }

    _resumePauseAwareWaiters() {
      for (const waiter of this._lineWaiters) {
        if (!waiter.pauseAware || !waiter.paused) {
          continue;
        }
        waiter.paused = false;
        this._startWaiterTimer(waiter);
      }
    }

    _startWaiterTimer(waiter) {
      if (!waiter) {
        return;
      }
      this._clearWaiterTimer(waiter);
      waiter.timerStartedAt = this._nowMs();
      waiter.timeoutId = window.setTimeout(() => {
        this._lineWaiters = this._lineWaiters.filter((item) => item !== waiter);
        waiter.reject(new Error(`Timed out waiting for ${waiter.context}.`));
      }, Math.max(0, Math.ceil(waiter.remainingMs)));
    }

    waitForLine(predicate, timeoutMs = DEFAULT_TIMEOUT_MS, context = "response", options = {}) {
      const afterId = Number.isFinite(options.afterId) ? options.afterId : -1;
      for (let i = this._recentLines.length - 1; i >= 0; i -= 1) {
        const entry = this._recentLines[i];
        if (entry.id <= afterId) {
          break;
        }
        const line = entry.line;
        try {
          if (predicate(line)) {
            return Promise.resolve(line);
          }
        } catch (error) {
          return Promise.reject(error);
        }
      }

      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          afterId,
          context,
          pauseAware: options.pauseAware === true,
          paused: false,
          remainingMs: Math.max(0, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
          timerStartedAt: 0,
          timeoutId: null
        };
        this._lineWaiters.push(waiter);
        this._startWaiterTimer(waiter);
      });
    }

    waitForReady(timeoutMs = 3000) {
      return this.waitForLine((line) => line === "READY", timeoutMs, "READY banner");
    }

    _enqueue(task, options = {}) {
      const command = typeof options.command === "string" ? options.command : "";
      this._queueDepth += 1;
      this._dispatchQueueDebug();

      const runTask = async () => {
        this._queueDepth = Math.max(0, this._queueDepth - 1);
        this._inFlightCommand = command;
        this._dispatchQueueDebug();
        try {
          return await task();
        } finally {
          this._inFlightCommand = "";
          this._dispatchQueueDebug();
        }
      };

      const next = this._commandQueue.then(runTask, runTask);
      this._commandQueue = next.catch(() => {});
      return next;
    }

    _withDeviceErrorGuard(predicate, command) {
      return (line) => {
        if (typeof line === "string" && line.startsWith("ERR:")) {
          throw new Error(`Device rejected ${command}: ${line}`);
        }
        return predicate(line);
      };
    }

    _waitForResponse(waitFor, timeoutMs, command, options = {}) {
      const responseOptions = {
        afterId: options.afterId,
        pauseAware: options.pauseAware === true
      };
      if (waitFor === null) {
        return Promise.resolve(null);
      }

      if (waitFor === "OK") {
        const predicate = this._withDeviceErrorGuard((line) => line === "OK", command);
        return this.waitForLine(predicate, timeoutMs, `ACK for ${command}`, responseOptions);
      }

      if (typeof waitFor === "function") {
        const predicate = this._withDeviceErrorGuard(waitFor, command);
        return this.waitForLine(predicate, timeoutMs, `response for ${command}`, responseOptions);
      }

      if (waitFor instanceof RegExp) {
        const predicate = this._withDeviceErrorGuard((line) => waitFor.test(line), command);
        return this.waitForLine(predicate, timeoutMs, `response for ${command}`, responseOptions);
      }

      const predicate = this._withDeviceErrorGuard((line) => line === String(waitFor), command);
      return this.waitForLine(predicate, timeoutMs, `response for ${command}`, responseOptions);
    }

    async _writeCommand(command) {
      if (!this.connected || !this.writer) {
        throw new Error("Serial connection is not active.");
      }

      const payload = this.encoder.encode(`${command}\n`);
      await this.writer.write(payload);
      this.dispatchEvent(new CustomEvent("tx", { detail: { command } }));
    }

    async _sendCommandNow(command, options = {}) {
      const waitFor = Object.prototype.hasOwnProperty.call(options, "waitFor") ? options.waitFor : "OK";
      const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
      const afterId = this._lineSeq;
      await this._writeCommand(command);
      return this._waitForResponse(waitFor, timeoutMs, command, {
        afterId,
        pauseAware: options.pauseAware === true
      });
    }

    async sendCommand(command, options = {}) {
      return this._enqueue(() => this._sendCommandNow(command, options), { command });
    }

    async moveServo(servo, angle, speed = 50) {
      const safeServo = clamp(Math.round(servo), 0, 5);
      const safeAngle = clamp(Math.round(angle), 0, 180);
      const safeSpeed = clamp(Math.round(speed), 1, 100);
      return this.sendCommand(`S${safeServo}:${safeAngle}:${safeSpeed}`, {
        waitFor: MOTION_ACK_PREDICATE,
        timeoutMs: MOTION_COMMAND_TIMEOUT_MS,
        pauseAware: true
      });
    }

    async home() {
      return this.sendCommand("H", {
        waitFor: MOTION_ACK_PREDICATE,
        timeoutMs: HOME_COMMAND_TIMEOUT_MS,
        pauseAware: true
      });
    }

    async pauseMotion(options = {}) {
      if (options.immediate === true && this._realtimeControl) {
        return this._sendCommandNow(this._realtimeControl.pauseCommand, {
          waitFor: this._realtimeControl.pauseAck,
          timeoutMs: REALTIME_CONTROL_TIMEOUT_MS
        });
      }
      return this.sendCommand("P");
    }

    async resumeMotion(options = {}) {
      if (options.immediate === true && this._realtimeControl) {
        return this._sendCommandNow(this._realtimeControl.resumeCommand, {
          waitFor: this._realtimeControl.resumeAck,
          timeoutMs: REALTIME_CONTROL_TIMEOUT_MS
        });
      }
      return this.sendCommand("R");
    }

    async waitDelay(ms) {
      const safeMs = clamp(Math.round(ms), 0, 30000);
      return this.sendCommand(`D:${safeMs}`, {
        timeoutMs: safeMs + MOTION_DELAY_GRACE_MS,
        waitFor: MOTION_ACK_PREDICATE,
        pauseAware: true
      });
    }

    async emergencyStop(options = {}) {
      const sendNow = options.immediate === true;
      const send = sendNow
        ? this._sendCommandNow.bind(this)
        : this.sendCommand.bind(this);

      return send("!", {
        waitFor: (line) => line === "STOPPED" || line === "OK"
      });
    }

    async attachAll() {
      return this.sendCommand("A");
    }

    async queryPositions() {
      const line = await this.sendCommand("Q", { waitFor: /^P/ });
      return parsePositions(line);
    }

    async getFirmwareProfile() {
      const line = await this.sendCommand("F", { waitFor: /^CFG:/, timeoutMs: 3000 });
      const profile = parseFirmwareProfile(line);
      if (!profile) {
        throw new Error("Invalid firmware profile response.");
      }
      this._firmwareProfile = profile;
      this._realtimeControl = profile.realtimeControl || null;
      return profile;
    }

    _dispatchStatus(message, connected) {
      this.dispatchEvent(new CustomEvent("status", {
        detail: {
          message,
          connected,
          transportKind: this.getTransportKind(),
          transportLabel: this.getTransportLabel()
        }
      }));
    }

    _dispatchQueueDebug() {
      this.dispatchEvent(new CustomEvent("queue", { detail: this.getQueueSnapshot() }));
    }
  }

  function parsePositions(line) {
    if (!line || !line.startsWith("P")) {
      return null;
    }

    const angles = Array(6).fill(null);
    const chunks = line.slice(1).split(",");

    for (const chunk of chunks) {
      const [servoText, angleText] = chunk.split(":");
      const servo = Number.parseInt(servoText, 10);
      const angle = Number.parseInt(angleText, 10);
      if (Number.isInteger(servo) && servo >= 0 && servo < 6 && Number.isInteger(angle)) {
        angles[servo] = angle;
      }
    }

    if (angles.some((value) => value === null)) {
      return null;
    }

    return angles;
  }

  function parseFirmwareProfile(line) {
    if (!line || !line.startsWith("CFG:")) {
      return null;
    }

    const parts = line.split(";");
    const profile = {
      id: parts[0].slice(4).trim(),
      rawLine: line
    };

    for (let i = 1; i < parts.length; i += 1) {
      const part = parts[i].trim();
      if (!part) {
        continue;
      }

      if (part.startsWith("GRIPPER:")) {
        const pair = parseIntTuple(part.slice("GRIPPER:".length), 2);
        if (pair) {
          profile.gripperMin = pair[0];
          profile.gripperMax = pair[1];
        }
        continue;
      }

      if (part.startsWith("US5:")) {
        const pair = parseIntTuple(part.slice("US5:".length), 2);
        if (pair) {
          profile.gripperUsMin = pair[0];
          profile.gripperUsMax = pair[1];
        }
        continue;
      }

      if (part.startsWith("RELIEF:")) {
        const tuple = parseIntTuple(part.slice("RELIEF:".length), 3);
        if (tuple) {
          profile.reliefMargin = tuple[0];
          profile.reliefDeg = tuple[1];
          profile.reliefDelayMs = tuple[2];
        }
        continue;
      }

      if (part.startsWith("RTCTRL:")) {
        const tuple = String(part.slice("RTCTRL:".length)).split(":");
        if (tuple.length === 4 && tuple.every((item) => item.length > 0)) {
          profile.realtimeControl = {
            pauseCommand: tuple[0],
            pauseAck: tuple[1],
            resumeCommand: tuple[2],
            resumeAck: tuple[3]
          };
        }
        continue;
      }

      if (part.startsWith("MOTION:")) {
        const tuple = parseIntTuple(part.slice("MOTION:".length), 6);
        if (tuple) {
          profile.motionTiming = {
            fastDelayMs: tuple[0],
            slowDelayMs: tuple[1],
            rampMaxSteps: tuple[2],
            rampExtraDelayMs: tuple[3],
            fineMoveDeg: tuple[4],
            pausePollMs: tuple[5]
          };
        }
      }
    }

    return profile;
  }

  function parseIntTuple(text, expectedCount) {
    const values = String(text || "").split(":").map((item) => Number.parseInt(item, 10));
    if (values.length !== expectedCount) {
      return null;
    }
    if (values.some((value) => !Number.isInteger(value))) {
      return null;
    }
    return values;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function detectTransportKind(port) {
    if (!port || typeof port.getInfo !== "function") {
      return "serial";
    }

    try {
      const info = port.getInfo() || {};
      const hasUsbIds = Number.isInteger(info.usbVendorId) || Number.isInteger(info.usbProductId);
      return hasUsbIds ? "usb" : "bluetooth";
    } catch (error) {
      return "serial";
    }
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  NS.SerialManager = SerialManager;
})();
