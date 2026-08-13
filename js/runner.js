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
        await this._runCommandList(prepareCommandList(commands || []), workspace);
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
      if (NS.RobotRuntime && typeof NS.RobotRuntime.getManifest === "function" && typeof NS.RobotRuntime.stop === "function") {
        const manifest = NS.RobotRuntime.getManifest();
        if (manifest && manifest.id !== "arduino_arm") {
          NS.RobotRuntime.stop();
        }
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
      if (NS.RobotRuntime && typeof NS.RobotRuntime.setSimulationPaused === "function") {
        NS.RobotRuntime.setSimulationPaused(true);
      }
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
      if (NS.RobotRuntime && typeof NS.RobotRuntime.setSimulationPaused === "function") {
        NS.RobotRuntime.setSimulationPaused(false);
      }
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
          await this._executeHomeCommand(cmd);
          return;

        case "wait":
          await this._executeDelay(Math.round(Number(cmd.seconds || 0) * 1000));
          return;

        case "delay":
          await this._executeDelay(cmd.ms);
          return;

        case "move_joint":
          await this._executeUniversalMoveJoint(cmd);
          return;

        case "move_joints":
          await this._executeUniversalMoveJoints(cmd);
          return;

        case "set_gripper":
          await this._executeUniversalSetGripper(cmd);
          return;

        case "drive":
          await this._executeRuntimeCommand(cmd);
          await this._executeDelay(Math.round(Number(cmd.seconds || 0) * 1000));
          return;

        case "smooth_move":
          await this._executeUniversalSmoothMove(cmd);
          return;

        case "set_posture":
        case "humanoid_walk":
        case "humanoid_turn":
        case "run_demo":
          {
            const applied = await this._executeRuntimeCommand(cmd);
            await this._executeDelay(Math.round(Number(applied.durationSeconds ?? applied.seconds ?? 0) * 1000));
          }
          return;

        case "pick_nearest":
        case "release_object":
          await this._executeRuntimeCommand(cmd);
          return;

        case "stop":
          await this._executeUniversalStop(cmd);
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
          const body = prepareCommandList(Array.isArray(cmd.body) ? cmd.body : []);
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

    async _executeHomeCommand(cmd) {
      if (isArduinoCommand(cmd)) {
        await this._executeHome();
        return;
      }
      await this._executeRuntimeCommand({ ...cmd, type: "home" });
    }

    async _executeUniversalMoveJoint(cmd) {
      if (isArduinoCommand(cmd)) {
        const legacy = toLegacyArduinoCommand(cmd);
        if (!legacy) {
          throw new Error(`Cannot map joint ${cmd.joint} to Arduino servo.`);
        }
        await this._executeServo(legacy);
        return;
      }
      await this._executeRuntimeCommand(cmd);
    }

    async _executeUniversalMoveJoints(cmd) {
      if (isArduinoCommand(cmd)) {
        const joints = cmd.joints || {};
        for (const [joint, value] of Object.entries(joints)) {
          if (this.stopRequested) {
            return;
          }
          await this._executeUniversalMoveJoint({
            type: "move_joint",
            robotId: cmd.robotId,
            joint,
            value,
            unit: cmd.unit,
            speed: cmd.speed,
            blockId: cmd.blockId
          });
        }
        return;
      }
      await this._executeRuntimeCommand(cmd);
    }

    async _executeUniversalSetGripper(cmd) {
      if (isArduinoCommand(cmd)) {
        const legacy = toLegacyArduinoCommand(cmd);
        if (!legacy) {
          throw new Error("Cannot map gripper command to Arduino servo.");
        }
        await this._executeServo(legacy);
        return;
      }
      await this._executeRuntimeCommand(cmd);
    }

    async _executeUniversalSmoothMove(cmd) {
      if (isArduinoCommand(cmd)) {
        const schema = NS.RobotCommandSchema;
        const manifest = NS.RobotRegistry ? NS.RobotRegistry.get("arduino_arm") : null;
        const joint = schema && manifest ? schema.resolveJoint(manifest, cmd.joint) : null;
        if (!joint) {
          throw new Error(`Cannot map joint ${cmd.joint} to Arduino servo.`);
        }
        await this._executeSmoothMove({
          type: "smoothMove",
          servo: joint.servoIndex ?? joint.index,
          from: cmd.from,
          to: cmd.to,
          durationMs: Math.round(Number(cmd.seconds || 1.5) * 1000),
          blockId: cmd.blockId
        });
        return;
      }
      await this._executeRuntimeCommand(cmd);
      await this._executeDelay(Math.round(Number(cmd.seconds || 1.5) * 1000));
    }

    async _executeUniversalStop(cmd) {
      if (isArduinoCommand(cmd) && this.serial.isConnected()) {
        await this.serial.emergencyStop();
      }
      if (!isArduinoCommand(cmd) && NS.RobotRuntime && typeof NS.RobotRuntime.stopHardware === "function") {
        await NS.RobotRuntime.stopHardware();
      } else if (NS.RobotRuntime) {
        NS.RobotRuntime.stop();
      }
      this.stopRequested = true;
      this._emitStatus("Emergency stop sent");
    }

    async _executeRuntimeCommand(cmd) {
      if (!NS.RobotRuntime || typeof NS.RobotRuntime.applyCommand !== "function") {
        throw new Error("Robot runtime is not available.");
      }
      const manifest = NS.RobotRuntime.getManifest && NS.RobotRuntime.getManifest();
      const validated = NS.RobotCommandSchema && typeof NS.RobotCommandSchema.validateCommand === "function"
        ? NS.RobotCommandSchema.validateCommand(cmd, { activeRobotId: manifest && manifest.id })
        : { ok: true, command: cmd };
      if (!validated.ok) {
        throw new Error(validated.error);
      }
      const safeCommand = validated.command || cmd;
      await NS.RobotRuntime.applyCommand(safeCommand);
      if (typeof NS.RobotRuntime.getJointArray === "function") {
        const angles = NS.RobotRuntime.getJointArray();
        if (Array.isArray(angles) && angles.length > 0) {
          this.applyAngles(angles);
        }
      }
      this._emitStatus(`${safeCommand.robotId || "Robot"} ${safeCommand.type} applied`);
      return safeCommand;
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

  function prepareCommandList(commands) {
    const schema = NS.RobotCommandSchema;
    if (!schema) {
      return Array.isArray(commands) ? commands : [];
    }
    return (Array.isArray(commands) ? commands : []).map((command) => {
      if (!command || typeof command !== "object") {
        return command;
      }
      if (command.type === "savePose" || command.type === "goPose" || command.type === "loopForever") {
        return {
          ...command,
          body: command.type === "loopForever" ? prepareCommandList(command.body || []) : command.body
        };
      }
      const activeRobotId = NS.RobotRegistry && NS.RobotRegistry.getActive ? NS.RobotRegistry.getActive().id : "arduino_arm";
      const result = schema.validateCommand(command, { activeRobotId });
      if (!result.ok) {
        throw new Error(result.error);
      }
      return { ...result.command, blockId: command.blockId };
    });
  }

  function isArduinoCommand(command) {
    const activeRobotId = NS.RobotRegistry && NS.RobotRegistry.getActive ? NS.RobotRegistry.getActive().id : "arduino_arm";
    const robotId = command && command.robotId ? command.robotId : activeRobotId;
    return robotId === "arduino_arm";
  }

  function toLegacyArduinoCommand(command) {
    if (!NS.RobotCommandSchema || typeof NS.RobotCommandSchema.toLegacyArduinoCommand !== "function") {
      return null;
    }
    return NS.RobotCommandSchema.toLegacyArduinoCommand(command);
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
