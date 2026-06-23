(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  // Keep gripper home aligned with firmware SERVO_HOME[5] to prevent close-end buzzing.
  const HOME_ANGLES = [90, 90, 90, 90, 90, 90];
  const JOINT_LIMITS = [[20, 130], [15, 165], [0, 180], [0, 180], [0, 180], [25, 130]];
  const SHOULDER_SERVO = 1;
  const SHOULDER_SPEED_BOOST = 16;
  const SHOULDER_FINE_MOVE_DEG = 4;
  const SHOULDER_FINE_SPEED_CAP = 62;
  const WRIST_ROTATE_SERVO = 3;
  const WRIST_ROTATE_FINE_MOVE_DEG = 6;
  const WRIST_ROTATE_FINE_SPEED_CAP = 58;
  const WRIST_ROTATE_LARGE_MOVE_SPEED_CAP = 70;
  const GRIPPER_SERVO = 5;
  const GRIPPER_RELIEF_MARGIN = 6;
  const GRIPPER_RELIEF_DEG = 3;
  const GRIPPER_RELIEF_DELAY_MS = 120;
  const MOTION_FAST_DELAY_MS = 20;
  const MOTION_SLOW_DELAY_MS = 34;
  const MOTION_RAMP_MAX_STEPS = 8;
  const MOTION_RAMP_EXTRA_DELAY_MS = 8;
  const MOTION_FINE_MOVE_DEG = 4;
  const MOTION_PAUSE_POLL_MS = 10;

  class ProgramRunner extends EventTarget {
    constructor(options) {
      super();
      this.serial = options.serial;
      this.getAngles = options.getAngles;
      this.applyAngles = options.applyAngles;
      this.getPose = options.getPose;
      this.savePose = options.savePose;
      this.speedMultiplier = 1;

      this.running = false;
      this.stopRequested = false;
      this.paused = false;
      this._immediateStopPromise = null;
    }

    isRunning() {
      return this.running;
    }

    isPaused() {
      return this.paused;
    }

    async run(commands, workspace) {
      if (this.running) {
        throw new Error("Program is already running.");
      }

      this.running = true;
      this.stopRequested = false;
      this.paused = false;
      this._immediateStopPromise = null;
      this._emitRunning(true);
      this._emitPaused(false);

      try {
        await this._runCommandList(commands || [], workspace);
        this._emitStatus(this.stopRequested ? "Program stopped" : "Program complete");
      } catch (error) {
        this._emitStatus(`Program error: ${error.message}`);
        this.dispatchEvent(new CustomEvent("error", { detail: { error } }));
      } finally {
        this.running = false;
        this.stopRequested = false;
        this.paused = false;
        this._immediateStopPromise = null;
        this._emitPaused(false);
        this._highlight(workspace, null);
        this._emitRunning(false);
      }
    }

    async stop(options = {}) {
      const mode = options.mode === "immediate" ? "immediate" : "graceful";
      this.stopRequested = true;
      if (this.paused) {
        this.paused = false;
        this._emitPaused(false);
      }
      if (!this.running) {
        return;
      }

      if (mode !== "immediate") {
        this._emitStatus("Stopping program...");
        return;
      }

      this._emitStatus("Stopping program...");
      if (!this.serial.isConnected()) {
        return;
      }

      if (!this._immediateStopPromise) {
        this._immediateStopPromise = (async () => {
          try {
            await this.serial.emergencyStop({ immediate: true });
          } catch (error) {
            this._emitStatus(`Stop command failed: ${error.message}`);
          } finally {
            this._immediateStopPromise = null;
          }
        })();
      }

      await this._immediateStopPromise;
    }

    async pause() {
      if (!this.running || this.paused) {
        return;
      }
      this.paused = true;
      this._emitPaused(true);
      if (this.serial.isConnected()) {
        try {
          await this.serial.pauseMotion({ immediate: true });
        } catch (error) {
          this._emitStatus(`Pause command failed: ${error.message}`);
        }
      }
      this._emitStatus("Program paused");
    }

    async resume() {
      if (!this.running || !this.paused) {
        return;
      }
      this.paused = false;
      this._emitPaused(false);
      if (this.serial.isConnected()) {
        try {
          await this.serial.resumeMotion({ immediate: true });
        } catch (error) {
          this._emitStatus(`Resume command failed: ${error.message}`);
        }
      }
      this._emitStatus("Program resumed");
    }

    async _runCommandList(commands, workspace) {
      for (const cmd of commands) {
        if (this.stopRequested) {
          return;
        }

        this._highlight(workspace, cmd.blockId || null);
        await this._waitIfPaused();

        if (this.stopRequested) {
          return;
        }

        await this._execute(cmd, workspace);
      }
    }

    async _execute(cmd, workspace) {
      switch (cmd.type) {
        case "servo":
          await this._executeServo(cmd);
          return;

        case "home":
          await this._executeHome();
          return;

        case "delay":
          await this._executeDelay(cmd.ms);
          return;

        case "savePose": {
          const current = this.getAngles();
          this.savePose(cmd.name, current);
          this._emitStatus(`Pose saved: ${cmd.name}`);
          return;
        }

        case "goPose": {
          const pose = this.getPose(cmd.name);
          if (!pose) {
            this._emitStatus(`Pose not found: ${cmd.name}`);
            return;
          }
          for (let servo = 0; servo < pose.length; servo += 1) {
            if (this.stopRequested) {
              return;
            }
            await this._executeServo({
              type: "servo",
              servo,
              angle: pose[servo],
              speed: cmd.speed || 50,
              blockId: cmd.blockId
            });
          }
          return;
        }

        case "smoothMove":
          await this._executeSmoothMove(cmd);
          return;

        case "loopForever": {
          const body = Array.isArray(cmd.body) ? cmd.body : [];
          if (body.length === 0) {
            return;
          }
          while (!this.stopRequested) {
            await this._runCommandList(body, workspace);
            await this._waitIfPaused();
          }
          return;
        }

        case "emergencyStop":
          if (this.serial.isConnected()) {
            await this.serial.emergencyStop();
          }
          this.stopRequested = true;
          this._emitStatus("Emergency stop sent");
          return;

        default:
          return;
      }
    }

    async _executeServo(cmd) {
      const speed = Math.min(100, Math.max(1, Math.round((cmd.speed || 50) * this.speedMultiplier)));
      const servo = Math.min(5, Math.max(0, Math.round(cmd.servo)));
      const angle = clampServo(servo, Math.round(cmd.angle));

      if (this.serial.isConnected()) {
        const angles = this.getAngles();
        angles[servo] = angle;
        this.applyAngles(angles);
        const line = await this.serial.moveServo(servo, angle, speed);
        this._consumeMotionAck(line);
      } else {
        const line = await this._simulateServoMove(servo, angle, speed);
        this._consumeMotionAck(line);
      }
    }

    async _executeHome() {
      if (this.serial.isConnected()) {
        this.applyAngles(HOME_ANGLES.slice());
        const line = await this.serial.home();
        this._consumeMotionAck(line);
      } else {
        const line = await this._simulateHome();
        this._consumeMotionAck(line);
      }
    }

    async _executeDelay(ms) {
      const scaledMs = Math.max(10, Math.round(ms / this.speedMultiplier));
      if (this.serial.isConnected()) {
        const line = await this.serial.waitDelay(scaledMs);
        this._consumeMotionAck(line);
      } else {
        const completed = await this._delayWithRealtimeControl(scaledMs);
        if (!completed) {
          this.stopRequested = true;
        }
      }
    }

    _consumeMotionAck(line) {
      if (line === "STOPPED") {
        this.stopRequested = true;
      }
    }

    async _simulateHome() {
      for (let servo = 0; servo < HOME_ANGLES.length; servo += 1) {
        if (this.stopRequested) {
          return "STOPPED";
        }
        const current = clampServo(servo, this.getAngles()[servo]);
        const speed = effectiveSpeedForServo(servo, 50, Math.abs(HOME_ANGLES[servo] - current));
        const line = await this._simulateServoMove(servo, HOME_ANGLES[servo], speed);
        if (line === "STOPPED") {
          return line;
        }
      }
      return "OK";
    }

    async _simulateServoMove(servo, targetAngle, speed) {
      let current = clampServo(servo, this.getAngles()[servo]);
      const target = clampServo(servo, targetAngle);
      const effectiveSpeed = effectiveSpeedForServo(servo, speed, Math.abs(target - current));

      if (current === target) {
        return "OK";
      }

      const step = target > current ? 1 : -1;
      const totalSteps = Math.abs(target - current);
      let stepIndex = 0;

      while (current !== target) {
        const canContinue = await this._delayWithRealtimeControl(0);
        if (!canContinue) {
          return "STOPPED";
        }

        current += step;
        this._applySimulatedServoAngle(servo, current);

        const delayMs = motionStepDelayMs(effectiveSpeed, stepIndex, totalSteps);
        const completedDelay = await this._delayWithRealtimeControl(delayMs);
        if (!completedDelay) {
          return "STOPPED";
        }
        stepIndex += 1;
      }

      if (servo === GRIPPER_SERVO) {
        const line = await this._applyGripperRelief();
        if (line === "STOPPED") {
          return line;
        }
      }

      return "OK";
    }

    async _applyGripperRelief() {
      const current = clampServo(GRIPPER_SERVO, this.getAngles()[GRIPPER_SERVO]);
      const [min, max] = JOINT_LIMITS[GRIPPER_SERVO];
      const minEdge = min + GRIPPER_RELIEF_MARGIN;
      const maxEdge = max - GRIPPER_RELIEF_MARGIN;
      let reliefAngle = current;

      if (current <= minEdge) {
        reliefAngle = clampServo(GRIPPER_SERVO, current + GRIPPER_RELIEF_DEG);
      } else if (current >= maxEdge) {
        reliefAngle = clampServo(GRIPPER_SERVO, current - GRIPPER_RELIEF_DEG);
      }

      if (reliefAngle === current) {
        return "OK";
      }

      const completed = await this._delayWithRealtimeControl(GRIPPER_RELIEF_DELAY_MS);
      if (!completed) {
        return "STOPPED";
      }

      this._applySimulatedServoAngle(GRIPPER_SERVO, reliefAngle);
      return "OK";
    }

    _applySimulatedServoAngle(servo, angle) {
      const angles = this.getAngles();
      angles[servo] = clampServo(servo, angle);
      this.applyAngles(angles);
    }

    async _delayWithRealtimeControl(delayMs) {
      if (this.stopRequested) {
        return false;
      }

      let remainingMs = Math.max(0, Math.round(delayMs));
      if (remainingMs <= 0) {
        await this._waitIfPaused();
        return !this.stopRequested;
      }

      let lastTickMs = window.performance.now();
      while (remainingMs > 0) {
        if (this.stopRequested) {
          return false;
        }

        if (this.paused) {
          await this._waitIfPaused();
          lastTickMs = window.performance.now();
          continue;
        }

        const nowMs = window.performance.now();
        const elapsedMs = nowMs - lastTickMs;
        if (elapsedMs >= remainingMs) {
          break;
        }

        remainingMs -= elapsedMs;
        lastTickMs = nowMs;
        await delay(Math.min(MOTION_PAUSE_POLL_MS, Math.max(1, Math.ceil(remainingMs))));
      }

      return !this.stopRequested;
    }

    async _executeSmoothMove(cmd) {
      const totalMs = Math.max(200, cmd.durationMs || 1500);
      const steps = Math.min(80, Math.max(6, Math.round(totalMs / 55)));
      const delta = (cmd.to - cmd.from) / steps;

      for (let step = 0; step <= steps; step += 1) {
        if (this.stopRequested) {
          return;
        }

        const angle = Math.round(cmd.from + delta * step);
        await this._executeServo({
          type: "servo",
          servo: cmd.servo,
          angle,
          speed: 70,
          blockId: cmd.blockId
        });

        await this._executeDelay(Math.round(totalMs / steps));
      }
    }

    async _waitIfPaused() {
      while (this.paused && !this.stopRequested) {
        await delay(40);
      }
    }

    _highlight(workspace, blockId) {
      if (!workspace) {
        return;
      }

      workspace.highlightBlock(blockId || null);
    }

    _emitStatus(text) {
      this.dispatchEvent(new CustomEvent("status", { detail: { text } }));
    }

    _emitRunning(running) {
      this.dispatchEvent(new CustomEvent("running", { detail: { running } }));
    }

    _emitPaused(paused) {
      this.dispatchEvent(new CustomEvent("paused", { detail: { paused: Boolean(paused) } }));
    }
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function clampServo(servo, angle) {
    const [min, max] = JOINT_LIMITS[servo] || [0, 180];
    const fallback = HOME_ANGLES[servo] ?? 90;
    const safeAngle = Number.isFinite(angle) ? angle : fallback;
    return Math.min(max, Math.max(min, Math.round(safeAngle)));
  }

  function effectiveSpeedForServo(servo, speed, moveDeltaDeg) {
    let safeSpeed = Math.min(100, Math.max(1, Math.round(speed)));
    if (servo === SHOULDER_SERVO) {
      if (moveDeltaDeg <= SHOULDER_FINE_MOVE_DEG) {
        safeSpeed = Math.min(safeSpeed, SHOULDER_FINE_SPEED_CAP);
      } else {
        safeSpeed = Math.min(100, Math.max(1, safeSpeed + SHOULDER_SPEED_BOOST));
      }
    }
    if (servo === WRIST_ROTATE_SERVO) {
      const cap = moveDeltaDeg <= WRIST_ROTATE_FINE_MOVE_DEG
        ? WRIST_ROTATE_FINE_SPEED_CAP
        : WRIST_ROTATE_LARGE_MOVE_SPEED_CAP;
      safeSpeed = Math.min(safeSpeed, cap);
    }
    return safeSpeed;
  }

  function motionBaseDelayMs(speed) {
    const safeSpeed = Math.min(100, Math.max(1, Math.round(speed)));
    return arduinoMap(safeSpeed, 1, 100, MOTION_SLOW_DELAY_MS, MOTION_FAST_DELAY_MS);
  }

  function motionStepDelayMs(speed, stepIndex, totalSteps) {
    const baseDelayMs = motionBaseDelayMs(speed);
    const safeTotalSteps = Math.max(1, Math.round(totalSteps));

    if (safeTotalSteps <= MOTION_FINE_MOVE_DEG) {
      return baseDelayMs + MOTION_RAMP_EXTRA_DELAY_MS;
    }

    const safeStepIndex = Math.min(safeTotalSteps - 1, Math.max(0, Math.round(stepIndex)));
    const edgeDistance = Math.min(safeStepIndex, safeTotalSteps - 1 - safeStepIndex);
    const rampSteps = Math.min(MOTION_RAMP_MAX_STEPS, Math.max(1, Math.floor(safeTotalSteps / 2)));
    if (edgeDistance >= rampSteps) {
      return baseDelayMs;
    }

    return baseDelayMs + Math.floor(((rampSteps - edgeDistance) * MOTION_RAMP_EXTRA_DELAY_MS + rampSteps - 1) / rampSteps);
  }

  function arduinoMap(value, inMin, inMax, outMin, outMax) {
    return Math.trunc(((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin);
  }

  NS.ProgramRunner = ProgramRunner;
})();
