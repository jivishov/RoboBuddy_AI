(() => {
  "use strict";

  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const NOOP = () => {};
  const ACTIVE_PHASES = new Set(["ready", "active"]);
  const BUTTON_CONTROL_NAMES = Object.freeze([
    "deadman", "fineOverride", "cancel", "stop", "previousPair", "nextPair"
  ]);

  function requiredObject(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`Gamepad ${path} must be an object.`);
    }
    return value;
  }

  function requiredString(value, path) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(`Gamepad ${path} must be a non-empty string.`);
    }
    return value.trim();
  }

  function requiredFiniteNumber(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`Gamepad ${path} must be a finite number.`);
    }
    return value;
  }

  function requiredNonNegativeInteger(value, path) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`Gamepad ${path} must be a non-negative integer.`);
    }
    return value;
  }

  function requiredButtonControl(controls, name) {
    const control = requiredObject(controls[name], `controls.${name}`);
    return { button: requiredNonNegativeInteger(control.button, `controls.${name}.button`) };
  }

  function normalizeConfig(value) {
    const source = requiredObject(value, "profile");
    const controls = requiredObject(source.controls, "controls");
    const move = requiredObject(controls.move, "controls.move");
    const result = {
      profileId: requiredString(source.profileId, "profileId"),
      mapping: requiredString(source.mapping, "mapping"),
      minimumAxes: requiredNonNegativeInteger(source.minimumAxes, "minimumAxes"),
      minimumButtons: requiredNonNegativeInteger(source.minimumButtons, "minimumButtons"),
      stickNeutral: requiredFiniteNumber(source.stickNeutral, "stickNeutral"),
      stickEngage: requiredFiniteNumber(source.stickEngage, "stickEngage"),
      deadmanEngage: requiredFiniteNumber(source.deadmanEngage, "deadmanEngage"),
      deadmanRelease: requiredFiniteNumber(source.deadmanRelease, "deadmanRelease"),
      neutralHoldMs: requiredFiniteNumber(source.neutralHoldMs, "neutralHoldMs"),
      pollGapMs: requiredFiniteNumber(source.pollGapMs, "pollGapMs"),
      controls: {
        move: {
          horizontalAxis: requiredNonNegativeInteger(move.horizontalAxis, "controls.move.horizontalAxis"),
          verticalAxis: requiredNonNegativeInteger(move.verticalAxis, "controls.move.verticalAxis"),
          invertVertical: move.invertVertical
        },
        ...Object.fromEntries(BUTTON_CONTROL_NAMES.map((name) => [name, requiredButtonControl(controls, name)]))
      }
    };

    if (typeof result.controls.move.invertVertical !== "boolean") {
      throw new TypeError("Gamepad controls.move.invertVertical must be a boolean.");
    }

    if (!(result.stickNeutral >= 0 && result.stickNeutral < result.stickEngage && result.stickEngage <= 1)) {
      throw new RangeError("Gamepad stick thresholds must satisfy 0 <= stickNeutral < stickEngage <= 1.");
    }
    if (!(result.deadmanRelease >= 0 && result.deadmanRelease < result.deadmanEngage && result.deadmanEngage <= 1)) {
      throw new RangeError("Gamepad deadman thresholds must satisfy 0 <= deadmanRelease < deadmanEngage <= 1.");
    }
    ["neutralHoldMs", "pollGapMs"].forEach((key) => {
      if (!(result[key] > 0)) throw new RangeError(`Gamepad ${key} must be greater than zero.`);
    });

    const requiredAxes = Math.max(result.controls.move.horizontalAxis, result.controls.move.verticalAxis) + 1;
    const buttonIndices = BUTTON_CONTROL_NAMES.map((name) => result.controls[name].button);
    const requiredButtons = Math.max(...buttonIndices) + 1;
    if (result.minimumAxes < requiredAxes) {
      throw new RangeError(`Gamepad minimumAxes must cover all mapped axes (at least ${requiredAxes}).`);
    }
    if (result.minimumButtons < requiredButtons) {
      throw new RangeError(`Gamepad minimumButtons must cover all mapped buttons (at least ${requiredButtons}).`);
    }
    if (result.controls.move.horizontalAxis === result.controls.move.verticalAxis) {
      throw new RangeError("Gamepad horizontal and vertical movement axes must be distinct.");
    }
    if (new Set(buttonIndices).size !== buttonIndices.length) {
      throw new RangeError("Gamepad button controls must use distinct button indices.");
    }
    return result;
  }

  function clone(value) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(clone);
    if (typeof value === "object") {
      const copy = {};
      Object.keys(value).forEach((key) => { copy[key] = clone(value[key]); });
      return copy;
    }
    return value;
  }

  function safeCallback(callback, payload) {
    try {
      callback(clone(payload));
    } catch (error) {
      // A UI callback must not stop safety polling or keep an old report live.
    }
  }

  function defaultNow() {
    return window.performance && typeof window.performance.now === "function"
      ? window.performance.now()
      : Date.now();
  }

  function gamepadsFrom(value) {
    if (!value || typeof value.length !== "number") return [];
    return Array.from(value);
  }

  function signatureFor(gamepad) {
    return `${gamepad.mapping}|${gamepad.axes.length}|${gamepad.buttons.length}`;
  }

  function controlSnapshot(report) {
    return JSON.stringify({
      axes: [report.axisX, report.axisY],
      buttons: BUTTON_CONTROL_NAMES.map((name) => [report.buttonValues[name], report.pressed[name]])
    });
  }

  class StandardGamepadController {
    constructor(options = {}) {
      this.config = normalizeConfig(options.config || {});
      this.callbacks = {
        state: typeof options.onState === "function" ? options.onState : NOOP,
        sample: typeof options.onSample === "function" ? options.onSample : NOOP,
        action: typeof options.onAction === "function" ? options.onAction : NOOP,
        fault: typeof options.onFault === "function" ? options.onFault : NOOP
      };

      const nativeGetGamepads = window.navigator && typeof window.navigator.getGamepads === "function"
        ? window.navigator.getGamepads.bind(window.navigator)
        : null;
      this.getGamepads = typeof options.getGamepads === "function" ? options.getGamepads : nativeGetGamepads;
      this.clock = typeof options.clock === "function" ? options.clock : defaultNow;
      this.requestFrame = typeof options.requestAnimationFrame === "function"
        ? options.requestAnimationFrame
        : window.requestAnimationFrame.bind(window);
      this.cancelFrame = typeof options.cancelAnimationFrame === "function"
        ? options.cancelAnimationFrame
        : window.cancelAnimationFrame.bind(window);

      this.supported = Boolean(this.getGamepads);
      this.enabled = false;
      this.destroyed = false;
      this.frameHandle = null;
      this.lastPollAt = null;
      this.generation = 0;
      this.selection = null;
      this.controllers = [];
      this.phase = "off";
      this.reason = "";
      this.lastStateKey = "";
      this.tick = this.tick.bind(this);
    }

    /**
     * Start discovery. Discovery only reports anonymous slots and capabilities;
     * it never selects a controller or persists/matches a Gamepad id.
     */
    discover() {
      if (this.destroyed) return { ok: false, error: "destroyed", controllers: [] };
      if (!this.supported) {
        this.enabled = false;
        this.setPhase("unsupported", "gamepad_api_unavailable", true);
        return { ok: false, error: "gamepad_api_unavailable", controllers: [] };
      }
      if (this.selection) {
        return { ok: false, error: "selection_active", controllers: clone(this.controllers) };
      }

      this.enabled = true;
      this.lastPollAt = null;
      this.setPhase("discovering", "awaiting_controller", true);
      const gamepads = this.readGamepads(false);
      if (gamepads) {
        this.refreshControllers(gamepads);
        this.setPhase(this.controllers.length ? "choose_controller" : "discovering", this.controllers.length ? "selection_required" : "awaiting_controller");
      }
      this.schedule();
      return { ok: true, controllers: clone(this.controllers) };
    }

    /**
     * Immediately poll after a gamepadconnected/gamepaddisconnected event.
     * The event is only a wake-up hint; the fresh getGamepads snapshot remains
     * authoritative. Regular animation-frame polling continues unchanged.
     */
    refresh(options = {}) {
      if (this.destroyed) return { ok: false, error: "destroyed" };
      if (!this.enabled) return { ok: false, error: "discovery_not_started" };
      const disconnectedIndex = Number(options && options.disconnectedIndex);
      if (
        this.selection &&
        Number.isInteger(disconnectedIndex) &&
        disconnectedIndex === this.selection.index
      ) {
        this.fault("controller_disconnected", { event: true });
        this.schedule();
        return { ok: true, state: this.getState() };
      }
      this.pollNow();
      this.schedule();
      return { ok: true, state: this.getState() };
    }

    /**
     * Select one currently connected slot. The returned generation is the only
     * controller identity used for this selection lifetime.
     */
    select(index) {
      if (this.destroyed) return { ok: false, error: "destroyed" };
      if (!this.enabled) return { ok: false, error: "discovery_not_started" };
      if (this.selection) return { ok: false, error: "selection_active" };
      if (!Number.isInteger(Number(index)) || Number(index) < 0) return { ok: false, error: "invalid_index" };

      const numericIndex = Number(index);
      const gamepads = this.readGamepads(false);
      if (!gamepads) return { ok: false, error: "gamepad_read_failed" };
      this.refreshControllers(gamepads);
      const gamepad = this.findGamepad(gamepads, numericIndex);
      if (!gamepad) return { ok: false, error: "controller_missing" };
      const support = this.supportFor(gamepad);
      if (!support.supported) return { ok: false, error: support.reason };

      const report = this.readReport(gamepad);
      if (!report.ok) return { ok: false, error: report.error };
      const now = this.now();
      const generation = ++this.generation;
      const controlsNeutral = report.rawMagnitude <= this.config.stickNeutral
        && report.deadman <= this.config.deadmanRelease
        && !report.pressed.fineOverride
        && !report.pressed.cancel
        && !report.pressed.stop
        && !report.pressed.previousPair
        && !report.pressed.nextPair;
      this.selection = {
        index: numericIndex,
        generation,
        signature: signatureFor(gamepad),
        lastTimestamp: report.timestamp,
        lastControlSnapshot: controlSnapshot(report),
        probeStage: controlsNeutral ? "awaiting_deflection" : "awaiting_center",
        neutralSince: null,
        stickEngaged: false,
        deadmanActive: false,
        mustReleaseDeadman: report.deadman > this.config.deadmanRelease,
        previousButtons: { ...report.pressed }
      };
      this.lastPollAt = now;
      this.setPhase("neutral_required", report.timestamp <= 0 ? "positive_timestamp_required" : controlsNeutral ? "input_probe_required" : "input_probe_controls_required", true);
      this.schedule();
      return { ok: true, selection: { index: numericIndex, generation } };
    }

    /**
     * Force a selected controller back through released-control neutral pickup.
     * Coordinators call this when an attempted engagement is rejected (for
     * example, because alignment or robot ownership changed).
     */
    requireNeutral(reason = "rearm_required") {
      if (!this.selection) return { ok: false, error: "no_selection" };
      const selection = this.selection;
      const wasActive = selection.deadmanActive;
      selection.deadmanActive = false;
      selection.stickEngaged = false;
      selection.mustReleaseDeadman = true;
      selection.probeStage = "awaiting_neutral";
      selection.neutralSince = null;
      if (wasActive) this.emitTerminalSample(selection, reason);
      this.setPhase("neutral_required", String(reason || "rearm_required"), true);
      return { ok: true, selection: this.publicSelection(selection) };
    }

    /** Stop polling and forget the selected slot. No controller is auto-resumed. */
    disable(reason = "disabled") {
      if (this.destroyed) return;
      const selection = this.selection;
      this.selection = null;
      if (selection && selection.deadmanActive) this.emitTerminalSample(selection, reason);
      this.enabled = false;
      if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
      this.lastPollAt = null;
      this.controllers = [];
      this.setPhase("off", String(reason || "disabled"), true);
    }

    /** Permanently stop the adapter. A destroyed instance cannot be restarted. */
    destroy() {
      if (this.destroyed) return;
      this.disable("destroyed");
      this.destroyed = true;
      this.setPhase("destroyed", "destroyed", true);
    }

    getState() {
      return clone(this.stateSnapshot());
    }

    now() {
      const value = Number(this.clock());
      return Number.isFinite(value) ? value : 0;
    }

    schedule() {
      if (!this.enabled || this.destroyed || this.frameHandle !== null) return;
      this.frameHandle = this.requestFrame(this.tick);
    }

    tick() {
      this.frameHandle = null;
      if (!this.enabled || this.destroyed) return;
      this.pollNow();
      this.schedule();
    }

    pollNow() {
      if (!this.enabled || this.destroyed) return;
      const now = this.now();
      if (this.selection && ACTIVE_PHASES.has(this.phase) && this.lastPollAt !== null && now - this.lastPollAt > this.config.pollGapMs) {
        this.fault("poll_gap", { elapsedMs: now - this.lastPollAt });
        return;
      }
      this.lastPollAt = now;

      const gamepads = this.readGamepads(Boolean(this.selection));
      if (!gamepads) return;
      this.refreshControllers(gamepads);
      if (this.selection) this.processSelection(gamepads, now);
      else if (this.phase !== "faulted") {
        this.setPhase(this.controllers.length ? "choose_controller" : "discovering", this.controllers.length ? "selection_required" : "awaiting_controller");
      }
    }

    readGamepads(faultSelected) {
      try {
        return gamepadsFrom(this.getGamepads());
      } catch (error) {
        if (faultSelected && this.selection) this.fault("gamepad_read_failed");
        else this.setPhase("unavailable", "gamepad_read_failed");
        return null;
      }
    }

    refreshControllers(gamepads) {
      const next = [];
      gamepads.forEach((gamepad, slot) => {
        if (!gamepad || gamepad.connected === false) return;
        const index = Number.isInteger(Number(gamepad.index)) ? Number(gamepad.index) : slot;
        const support = this.supportFor(gamepad);
        next.push({
          index,
          label: `Gamepad ${index + 1}`,
          mapping: String(gamepad.mapping || ""),
          axes: gamepad.axes && typeof gamepad.axes.length === "number" ? gamepad.axes.length : 0,
          buttons: gamepad.buttons && typeof gamepad.buttons.length === "number" ? gamepad.buttons.length : 0,
          supported: support.supported,
          reason: support.reason
        });
      });
      next.sort((left, right) => left.index - right.index);
      const changed = JSON.stringify(next) !== JSON.stringify(this.controllers);
      this.controllers = next;
      if (changed) this.emitState();
    }

    supportFor(gamepad) {
      if (!gamepad || gamepad.connected === false) return { supported: false, reason: "controller_disconnected" };
      if (String(gamepad.mapping || "") !== this.config.mapping) return { supported: false, reason: "unsupported_mapping" };
      if (!gamepad.axes || typeof gamepad.axes.length !== "number" || gamepad.axes.length < this.config.minimumAxes) {
        return { supported: false, reason: "insufficient_axes" };
      }
      if (!gamepad.buttons || typeof gamepad.buttons.length !== "number" || gamepad.buttons.length < this.config.minimumButtons) {
        return { supported: false, reason: "insufficient_buttons" };
      }
      return { supported: true, reason: "" };
    }

    findGamepad(gamepads, index) {
      const direct = gamepads[index];
      if (direct && (direct.index === undefined || Number(direct.index) === index)) return direct;
      return gamepads.find((gamepad, slot) => gamepad && Number(gamepad.index === undefined ? slot : gamepad.index) === index) || null;
    }

    processSelection(gamepads, now) {
      const selection = this.selection;
      const gamepad = this.findGamepad(gamepads, selection.index);
      if (!gamepad) {
        this.fault("controller_missing");
        return;
      }
      if (gamepad.connected === false) {
        this.fault("controller_disconnected");
        return;
      }
      const support = this.supportFor(gamepad);
      if (!support.supported) {
        this.fault(support.reason);
        return;
      }
      if (signatureFor(gamepad) !== selection.signature) {
        this.fault("controller_signature_changed");
        return;
      }

      const report = this.readReport(gamepad);
      if (!report.ok) {
        this.fault(report.error);
        return;
      }
      if (report.timestamp < selection.lastTimestamp) {
        this.fault("timestamp_rollback", { timestamp: report.timestamp, previousTimestamp: selection.lastTimestamp });
        return;
      }
      const nextControlSnapshot = controlSnapshot(report);
      const valuesChanged = nextControlSnapshot !== selection.lastControlSnapshot;
      const timestampAdvanced = report.timestamp > selection.lastTimestamp;
      if (valuesChanged && !timestampAdvanced) {
        this.fault("timestamp_inconsistent", { timestamp: report.timestamp });
        return;
      }
      if (timestampAdvanced) {
        selection.lastTimestamp = report.timestamp;
        selection.lastControlSnapshot = nextControlSnapshot;
      }
      if (this.phase === "neutral_required" && report.timestamp <= 0) {
        this.setPhase("neutral_required", "positive_timestamp_required");
        return;
      }
      const stopRising = report.pressed.stop && !selection.previousButtons.stop;
      const cancelRising = report.pressed.cancel && !selection.previousButtons.cancel;
      const previousPairRising = report.pressed.previousPair && !selection.previousButtons.previousPair;
      const nextPairRising = report.pressed.nextPair && !selection.previousButtons.nextPair;
      selection.previousButtons = { ...report.pressed };

      if (stopRising) {
        const actionSelection = this.publicSelection(selection);
        const wasActive = selection.deadmanActive;
        this.selection = null;
        if (wasActive) this.emitTerminalSample(selection, "stop");
        safeCallback(this.callbacks.action, {
          type: "stop",
          at: now,
          timestamp: report.timestamp,
          selection: actionSelection
        });
        if (this.enabled && !this.destroyed) this.setPhase(this.controllers.length ? "choose_controller" : "discovering", "stop", true);
        return;
      }

      if (cancelRising) {
        const wasActive = selection.deadmanActive;
        selection.deadmanActive = false;
        selection.stickEngaged = false;
        selection.mustReleaseDeadman = true;
        selection.probeStage = "awaiting_neutral";
        selection.neutralSince = null;
        if (wasActive) this.emitTerminalSample(selection, "cancel");
        this.setPhase("neutral_required", "cancel_release_required", true);
        safeCallback(this.callbacks.action, {
          type: "cancel",
          at: now,
          timestamp: report.timestamp,
          selection: this.publicSelection(selection)
        });
        return;
      }

      if (this.phase === "neutral_required") {
        this.qualifyNeutral(selection, report, now, timestampAdvanced);
        return;
      }

      const stick = this.mapStick(selection, report.axisX, report.axisY);
      const controlsIdle = !selection.deadmanActive && report.deadman <= this.config.deadmanRelease && report.rawMagnitude <= this.config.stickNeutral;
      if (controlsIdle && previousPairRising !== nextPairRising) {
        safeCallback(this.callbacks.action, {
          type: previousPairRising ? "previous_pair" : "next_pair",
          at: now,
          timestamp: report.timestamp,
          selection: this.publicSelection(selection)
        });
      }

      const wasActive = selection.deadmanActive;
      if (selection.mustReleaseDeadman) {
        if (report.deadman <= this.config.deadmanRelease) selection.mustReleaseDeadman = false;
        selection.deadmanActive = false;
      } else if (selection.deadmanActive) {
        if (report.deadman <= this.config.deadmanRelease) selection.deadmanActive = false;
      } else if (report.deadman >= this.config.deadmanEngage) {
        if (report.rawMagnitude <= this.config.stickNeutral) {
          selection.deadmanActive = true;
          selection.stickEngaged = false;
        } else {
          selection.mustReleaseDeadman = true;
          this.setPhase("ready", "center_before_deadman");
        }
      }

      if (selection.deadmanActive) {
        this.setPhase("active", "deadman_held");
        this.emitSample(selection, report, stick, true, report.pressed.fineOverride, false, "");
      } else if (wasActive) {
        selection.stickEngaged = false;
        this.emitSample(selection, report, { x: 0, y: 0 }, false, false, true, "released");
        this.setPhase("ready", "deadman_released");
      } else if (this.phase !== "ready") {
        this.setPhase("ready", selection.mustReleaseDeadman ? "deadman_release_required" : "ready");
      }
    }

    qualifyNeutral(selection, report, now, timestampAdvanced) {
      const buttonsReleased = report.deadman <= this.config.deadmanRelease
        && !report.pressed.fineOverride
        && !report.pressed.cancel
        && !report.pressed.stop
        && !report.pressed.previousPair
        && !report.pressed.nextPair;
      const neutral = report.rawMagnitude <= this.config.stickNeutral && buttonsReleased;

      if (selection.probeStage === "awaiting_center") {
        selection.neutralSince = null;
        if (!buttonsReleased || report.rawMagnitude > this.config.stickNeutral) {
          this.setPhase("neutral_required", "input_probe_controls_required");
          return;
        }
        selection.probeStage = "awaiting_deflection";
        this.setPhase("neutral_required", "input_probe_required", true);
        return;
      }

      if (selection.probeStage === "awaiting_deflection") {
        selection.neutralSince = null;
        if (!buttonsReleased) {
          selection.probeStage = "awaiting_center";
          this.setPhase("neutral_required", "input_probe_controls_required");
          return;
        }
        if (timestampAdvanced && report.rawMagnitude >= this.config.stickEngage) {
          selection.probeStage = "awaiting_return";
          this.setPhase("neutral_required", "input_probe_return_required", true);
        } else {
          this.setPhase("neutral_required", "input_probe_required");
        }
        return;
      }

      if (selection.probeStage === "awaiting_return") {
        selection.neutralSince = null;
        if (!buttonsReleased) {
          selection.probeStage = "awaiting_center";
          this.setPhase("neutral_required", "input_probe_controls_required", true);
          return;
        }
        if (!timestampAdvanced || report.rawMagnitude > this.config.stickNeutral) {
          this.setPhase("neutral_required", "input_probe_return_required");
          return;
        }
        selection.probeStage = "neutral_dwell";
      }

      if (!neutral) {
        selection.neutralSince = null;
        selection.mustReleaseDeadman = report.deadman > this.config.deadmanRelease;
        this.setPhase("neutral_required", "center_and_release_controls");
        return;
      }
      selection.mustReleaseDeadman = false;
      selection.probeStage = "neutral_dwell";
      if (selection.neutralSince === null) selection.neutralSince = now;
      if (now - selection.neutralSince >= this.config.neutralHoldMs) {
        selection.stickEngaged = false;
        selection.deadmanActive = false;
        this.setPhase("ready", "ready", true);
      } else {
        this.setPhase("neutral_required", "neutral_hold");
      }
    }

    mapStick(selection, axisX, axisY) {
      const actualMagnitude = Math.hypot(axisX, axisY);
      const rawMagnitude = Math.min(1, actualMagnitude);
      if (selection.stickEngaged) {
        if (rawMagnitude <= this.config.stickNeutral) selection.stickEngaged = false;
      } else if (rawMagnitude >= this.config.stickEngage) {
        selection.stickEngaged = true;
      }
      if (!selection.stickEngaged || rawMagnitude <= this.config.stickNeutral) return { x: 0, y: 0 };
      const response = Math.pow((rawMagnitude - this.config.stickNeutral) / (1 - this.config.stickNeutral), 3);
      return {
        x: axisX / actualMagnitude * response,
        y: axisY / actualMagnitude * response
      };
    }

    readReport(gamepad) {
      const move = this.config.controls.move;
      const axisX = Number(gamepad.axes[move.horizontalAxis]);
      const rawVertical = Number(gamepad.axes[move.verticalAxis]);
      if (!Number.isFinite(axisX) || !Number.isFinite(rawVertical) || axisX < -1 || axisX > 1 || rawVertical < -1 || rawVertical > 1) {
        return { ok: false, error: "invalid_axis_report" };
      }
      const axisY = move.invertVertical ? -rawVertical : rawVertical;
      const timestamp = Number(gamepad.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < 0) return { ok: false, error: "invalid_timestamp" };

      const buttonValues = {};
      const pressed = {};
      for (const key of ["deadman", "fineOverride", "cancel", "stop", "previousPair", "nextPair"]) {
        const button = gamepad.buttons[this.config.controls[key].button];
        if (!button || !Number.isFinite(Number(button.value)) || Number(button.value) < 0 || Number(button.value) > 1) {
          return { ok: false, error: "invalid_button_report" };
        }
        buttonValues[key] = Number(button.value);
        pressed[key] = Boolean(button.pressed) || buttonValues[key] >= 0.5;
      }
      // RT is analog. GamepadButton.pressed has a browser-defined threshold and
      // must not bypass the configured 0.65/0.35 engage/release hysteresis.
      const deadman = buttonValues.deadman;
      return {
        ok: true,
        timestamp,
        axisX,
        axisY,
        rawMagnitude: Math.min(1, Math.hypot(axisX, axisY)),
        deadman,
        buttonValues,
        pressed
      };
    }

    emitSample(selection, report, vector, deadman, fineOverride, released, reason) {
      safeCallback(this.callbacks.sample, {
        profileId: this.config.profileId,
        at: this.now(),
        timestamp: report.timestamp,
        selection: this.publicSelection(selection),
        vector: { x: vector.x, y: vector.y },
        deadman: Boolean(deadman),
        fineOverride: Boolean(fineOverride),
        released: Boolean(released),
        terminal: false,
        reason: String(reason || "")
      });
    }

    emitTerminalSample(selection, reason) {
      safeCallback(this.callbacks.sample, {
        profileId: this.config.profileId,
        at: this.now(),
        timestamp: selection.lastTimestamp,
        selection: this.publicSelection(selection),
        vector: { x: 0, y: 0 },
        deadman: false,
        fineOverride: false,
        released: true,
        terminal: true,
        reason: String(reason || "fault")
      });
    }

    fault(code, details = {}) {
      const selection = this.selection;
      if (!selection) return;
      const wasActive = selection.deadmanActive;
      const publicSelection = this.publicSelection(selection);
      const timestamp = selection.lastTimestamp;
      this.selection = null;
      if (wasActive) this.emitTerminalSample(selection, code);
      if (this.enabled && !this.destroyed) this.setPhase("faulted", code, true);
      safeCallback(this.callbacks.fault, {
        code: String(code),
        at: this.now(),
        timestamp,
        selection: publicSelection,
        wasActive,
        details
      });
    }

    publicSelection(selection = this.selection) {
      return selection ? { index: selection.index, generation: selection.generation } : null;
    }

    setPhase(phase, reason = "", force = false) {
      this.phase = phase;
      this.reason = reason;
      this.emitState(force);
    }

    stateSnapshot() {
      return {
        profileId: this.config.profileId,
        phase: this.phase,
        reason: this.reason,
        supported: this.supported,
        enabled: this.enabled,
        ready: this.phase === "ready",
        active: this.phase === "active",
        selection: this.publicSelection(),
        controllers: clone(this.controllers)
      };
    }

    emitState(force = false) {
      const state = this.stateSnapshot();
      const key = JSON.stringify(state);
      if (!force && key === this.lastStateKey) return;
      this.lastStateKey = key;
      safeCallback(this.callbacks.state, state);
    }
  }

  /**
   * Dependency-injected, browser-only Xbox/standard Gamepad adapter.
   *
   * create({
   *   config, getGamepads, clock, requestAnimationFrame, cancelAnimationFrame,
   *   onState, onSample, onAction, onFault
   * })
   *
   * The adapter produces normalized input only. It deliberately has no robot,
   * bridge, storage, Web Bluetooth, WebHID, or haptics behavior.
   */
  NS.StandardGamepadInput = Object.freeze({
    create: (options) => new StandardGamepadController(options)
  });
})();
