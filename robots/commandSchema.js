(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const registry = NS.RobotRegistry;
  const safety = NS.RobotSafety;

  const LEGACY_SERVO_JOINTS = ["base", "shoulder", "elbow", "wrist_rot", "wrist_tilt", "gripper"];
  const KNOWN_COMMANDS = new Set([
    "home",
    "stop",
    "wait",
    "move_joint",
    "move_joints",
    "set_gripper",
    "drive",
    "smooth_move"
  ]);

  function commandError(message) {
    return { ok: false, error: message };
  }

  function commandOk(command, warnings = []) {
    return { ok: true, command, warnings };
  }

  function getActiveRobotId() {
    return registry && registry.getActive() ? registry.getActive().id : "arduino_arm";
  }

  function getManifest(robotId) {
    return registry ? registry.get(robotId) : null;
  }

  function hasCapability(manifest, capability) {
    return Boolean(manifest && Array.isArray(manifest.capabilities) && manifest.capabilities.includes(capability));
  }

  function speedInRange(value, label, joint) {
    const min = Number(joint && joint.speedMin) || safety.SAFETY_LIMITS.speedMin;
    const max = Number(joint && joint.speedMax) || safety.SAFETY_LIMITS.speedMax;
    const speed = Math.round(Number(value ?? 50));
    if (!Number.isFinite(speed) || speed < min || speed > max) {
      throw new Error(`${label} speed must be ${min}..${max}`);
    }
    return speed;
  }

  function speedForRunner(value) {
    const speed = Math.round(Number(value ?? 50));
    if (!Number.isFinite(speed) || speed < safety.SAFETY_LIMITS.speedMin || speed > safety.SAFETY_LIMITS.speedMax) {
      throw new Error(`speed must be ${safety.SAFETY_LIMITS.speedMin}..${safety.SAFETY_LIMITS.speedMax}`);
    }
    return speed;
  }

  function numberInRange(value, min, max, label) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
      throw new Error(`${label} must be ${min}..${max}`);
    }
    return numeric;
  }

  function normalizeJointKey(value) {
    return String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  }

  function resolveJoint(manifest, jointValue) {
    if (!manifest || !Array.isArray(manifest.joints)) {
      return null;
    }
    const joints = safety && typeof safety.getJointMap === "function"
      ? Object.values(safety.getJointMap(manifest))
      : manifest.joints.map((joint, index) => ({ ...joint, index }));
    if (typeof jointValue === "number" || /^[0-9]+$/.test(String(jointValue))) {
      const index = Math.round(Number(jointValue));
      return joints[index] || null;
    }
    const key = normalizeJointKey(jointValue);
    return joints.find((joint) => (
        normalizeJointKey(joint.id) === key ||
        normalizeJointKey(joint.label) === key ||
        (manifest.id === "arduino_arm" && LEGACY_SERVO_JOINTS[joint.servoIndex] === key)
      )) || null;
  }

  function jointIdForLegacyServo(servo) {
    const index = Math.round(Number(servo));
    return LEGACY_SERVO_JOINTS[index] || null;
  }

  function toLegacyArduinoCommand(command) {
    const manifest = getManifest(command.robotId || "arduino_arm");
    if (!manifest || manifest.id !== "arduino_arm") {
      return null;
    }
    switch (command.type) {
      case "home":
        return { type: "home", blockId: command.blockId };
      case "stop":
        return { type: "emergencyStop", blockId: command.blockId };
      case "wait":
        return { type: "delay", ms: Math.round(Number(command.seconds || 0) * 1000), blockId: command.blockId };
      case "move_joint": {
        const joint = resolveJoint(manifest, command.joint);
        return joint ? { type: "servo", servo: joint.servoIndex ?? joint.index, angle: Math.round(Number(command.value)), speed: command.speed || 50, blockId: command.blockId } : null;
      }
      case "set_gripper": {
        const joint = resolveJoint(manifest, "gripper");
        return joint ? { type: "servo", servo: joint.servoIndex ?? joint.index, angle: Math.round(Number(command.value)), speed: command.speed || 50, blockId: command.blockId } : null;
      }
      default:
        return null;
    }
  }

  function normalizeLegacyCommand(command) {
    const type = String(command.type || "");
    if (type === "servo") {
      const joint = jointIdForLegacyServo(command.servo);
      if (!joint) {
        throw new Error("Legacy servo command must target servo 0..5.");
      }
      return {
        type: "move_joint",
        robotId: "arduino_arm",
        joint,
        value: command.angle,
        unit: "deg",
        speed: command.speed,
        blockId: command.blockId
      };
    }
    if (type === "delay") {
      return { type: "wait", robotId: "arduino_arm", seconds: Number(command.ms || 0) / 1000, blockId: command.blockId };
    }
    if (type === "emergencyStop") {
      return { type: "stop", robotId: "arduino_arm", reason: "user", blockId: command.blockId };
    }
    return null;
  }

  function normalizeCommand(command, options = {}) {
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new Error("Command must be an object.");
    }
    const legacy = normalizeLegacyCommand(command);
    if (legacy) {
      return legacy;
    }
    const type = String(command.type || "");
    if (!KNOWN_COMMANDS.has(type)) {
      throw new Error(`Unsupported command type: ${type || "(missing)"}.`);
    }
    const robotId = command.robotId
      ? registry.resolveRobotId(command.robotId)
      : (type === "wait" ? (options.activeRobotId || getActiveRobotId()) : (options.activeRobotId || getActiveRobotId()));
    return { ...command, type, robotId };
  }

  function validateCommand(command, options = {}) {
    let normalized;
    try {
      normalized = normalizeCommand(command, options);
      const manifest = getManifest(normalized.robotId);
      if (!manifest) {
        return commandError(`Unknown robot id: ${normalized.robotId}.`);
      }

      switch (normalized.type) {
        case "stop":
          return commandOk({
            type: "stop",
            robotId: manifest.id,
            reason: normalized.reason || "user",
            blockId: normalized.blockId
          });

        case "home":
          if (!hasCapability(manifest, "home")) {
            return commandError(`${manifest.name} does not support home.`);
          }
          return commandOk({ type: "home", robotId: manifest.id, blockId: normalized.blockId });

        case "wait": {
          const seconds = numberInRange(
            normalized.seconds,
            safety.SAFETY_LIMITS.waitMinSeconds,
            safety.SAFETY_LIMITS.waitMaxSeconds,
            "wait seconds"
          );
          return commandOk({ type: "wait", seconds, robotId: manifest.id, blockId: normalized.blockId });
        }

        case "move_joint": {
          if (!hasCapability(manifest, "joint_control")) {
            return commandError(`${manifest.name} does not support joint control.`);
          }
          const joint = resolveJoint(manifest, normalized.joint);
          if (!joint) {
            return commandError(`Unknown joint for ${manifest.id}: ${normalized.joint}.`);
          }
          const value = numberInRange(normalized.value, Number(joint.min), Number(joint.max), `${joint.label} value`);
          const speed = speedInRange(normalized.speed ?? 50, `${joint.label}`, joint);
          return commandOk({
            type: "move_joint",
            robotId: manifest.id,
            joint: joint.id,
            value,
            unit: normalized.unit || joint.unit || "deg",
            speed,
            blockId: normalized.blockId
          });
        }

        case "move_joints": {
          if (!hasCapability(manifest, "multi_joint_pose")) {
            return commandError(`${manifest.name} does not support multi-joint poses.`);
          }
          const rawJoints = normalized.joints && typeof normalized.joints === "object" ? normalized.joints : {};
          const joints = {};
          Object.entries(rawJoints).forEach(([jointKey, rawValue]) => {
            const joint = resolveJoint(manifest, jointKey);
            if (!joint) {
              throw new Error(`Unknown joint for ${manifest.id}: ${jointKey}.`);
            }
            joints[joint.id] = numberInRange(rawValue, Number(joint.min), Number(joint.max), `${joint.label} value`);
          });
          if (Object.keys(joints).length === 0) {
            return commandError("move_joints must include at least one joint.");
          }
          return commandOk({
            type: "move_joints",
            robotId: manifest.id,
            joints,
            unit: normalized.unit || "deg",
            speed: speedInRange(normalized.speed ?? 50, "move_joints", null),
            blockId: normalized.blockId
          });
        }

        case "set_gripper": {
          if (!hasCapability(manifest, "gripper")) {
            return commandError(`${manifest.name} does not support gripper control.`);
          }
          const joint = resolveJoint(manifest, "gripper");
          if (!joint) {
            return commandError(`${manifest.name} does not define a gripper joint.`);
          }
          let value = normalized.value;
          if (value === "open") {
            value = joint.open;
          } else if (value === "close" || value === "closed") {
            value = joint.close;
          }
          value = numberInRange(value, Number(joint.min), Number(joint.max), `${joint.label} value`);
          return commandOk({
            type: "set_gripper",
            robotId: manifest.id,
            value,
            speed: speedInRange(normalized.speed ?? 50, `${joint.label}`, joint),
            blockId: normalized.blockId
          });
        }

        case "drive": {
          if (!manifest.mobileBase || (!hasCapability(manifest, "drive_2d") && !hasCapability(manifest, "holonomic_drive"))) {
            return commandError(`drive is only available for robots with a mobile base.`);
          }
          const maxLinear = Number(manifest.mobileBase.maxLinearSpeed) || 1;
          const maxAngular = Number(manifest.mobileBase.maxAngularSpeed) || 90;
          return commandOk({
            type: "drive",
            robotId: manifest.id,
            vx: numberInRange(normalized.vx ?? 0, -maxLinear, maxLinear, "drive vx"),
            vy: numberInRange(normalized.vy ?? 0, -maxLinear, maxLinear, "drive vy"),
            omega: numberInRange(normalized.omega ?? 0, -maxAngular, maxAngular, "drive omega"),
            seconds: numberInRange(normalized.seconds ?? 1, safety.SAFETY_LIMITS.waitMinSeconds, safety.SAFETY_LIMITS.waitMaxSeconds, "drive seconds"),
            frame: normalized.frame === "world" ? "world" : "robot",
            blockId: normalized.blockId
          });
        }

        case "smooth_move": {
          const joint = resolveJoint(manifest, normalized.joint);
          if (!joint) {
            return commandError(`Unknown joint for ${manifest.id}: ${normalized.joint}.`);
          }
          const from = numberInRange(normalized.from, Number(joint.min), Number(joint.max), `${joint.label} start`);
          const to = numberInRange(normalized.to, Number(joint.min), Number(joint.max), `${joint.label} end`);
          const seconds = numberInRange(
            normalized.seconds ?? 1.5,
            safety.SAFETY_LIMITS.smoothMoveMinSeconds,
            safety.SAFETY_LIMITS.smoothMoveMaxSeconds,
            "smooth move seconds"
          );
          return commandOk({
            type: "smooth_move",
            robotId: manifest.id,
            joint: joint.id,
            from,
            to,
            seconds,
            blockId: normalized.blockId
          });
        }

        default:
          return commandError(`Unsupported command type: ${normalized.type}.`);
      }
    } catch (error) {
      return commandError(error.message || String(error));
    }
  }

  function validateCommandList(commands, options = {}) {
    if (!Array.isArray(commands)) {
      throw new Error("Command list must be an array.");
    }
    if (commands.length > safety.SAFETY_LIMITS.maxCommands) {
      throw new Error(`Too many commands (${commands.length}/${safety.SAFETY_LIMITS.maxCommands}).`);
    }
    const validated = [];
    let robotId = null;
    for (let index = 0; index < commands.length; index += 1) {
      const rawType = commands[index] && commands[index].type;
      if (rawType === "savePose") {
        const name = String(commands[index].name || "").trim();
        if (!name) {
          throw new Error(`Command ${index + 1}: pose name cannot be empty.`);
        }
        validated.push({ type: "savePose", name: name.slice(0, 40), blockId: commands[index].blockId });
        continue;
      }
      if (rawType === "goPose") {
        const name = String(commands[index].name || "").trim();
        if (!name) {
          throw new Error(`Command ${index + 1}: pose name cannot be empty.`);
        }
        validated.push({ type: "goPose", name: name.slice(0, 40), speed: speedForRunner(commands[index].speed), blockId: commands[index].blockId });
        continue;
      }
      if (rawType === "loopForever") {
        validated.push({ type: "loopForever", body: validateCommandList(commands[index].body || [], options), blockId: commands[index].blockId });
        continue;
      }
      const result = validateCommand(commands[index], options);
      if (!result.ok) {
        throw new Error(`Command ${index + 1}: ${result.error}`);
      }
      const currentRobotId = result.command.robotId;
      if (robotId && currentRobotId !== robotId && result.command.type !== "stop") {
        throw new Error(`Command ${index + 1}: cross-robot command queues are not supported (${robotId} then ${currentRobotId}).`);
      }
      if (!robotId && result.command.type !== "wait") {
        robotId = currentRobotId;
      }
      validated.push(result.command);
    }
    return validated;
  }

  NS.RobotCommandSchema = {
    LEGACY_SERVO_JOINTS,
    validateCommand,
    validateCommandList,
    normalizeCommand,
    resolveJoint,
    toLegacyArduinoCommand,
    jointIdForLegacyServo
  };
})();
