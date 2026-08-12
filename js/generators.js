(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const JOINT_LIMITS = [
    [20, 130],
    [15, 165],
    [0, 180],
    [0, 180],
    [0, 180],
    [25, 130]
  ];
  const LEGACY_JOINT_ORDER = ["base", "shoulder", "elbow", "wrist_rot", "wrist_tilt", "gripper"];
  const LEGACY_JOINT_ALIASES = new Map([
    ["base", 0],
    ["shoulder", 1],
    ["elbow", 2],
    ["wristrot", 3],
    ["wrist_rot", 3],
    ["wristrotation", 3],
    ["wristtilt", 4],
    ["wrist_tilt", 4],
    ["gripper", 5]
  ]);
  const GRIPPER_DEFAULT_SPEED = 55;

  function activeManifest() {
    return NS.RobotRegistry && NS.RobotRegistry.getActive
      ? NS.RobotRegistry.getActive()
      : null;
  }

  function generateCommands(workspace) {
    if (!workspace) {
      return [];
    }

    const commands = [];
    const topBlocks = workspace.getTopBlocks(true);
    for (const block of topBlocks) {
      compileChain(block, commands);
    }
    return validateGenerated(commands);
  }

  function compileChain(startBlock, outCommands) {
    let block = startBlock;
    while (block) {
      compileBlock(block, outCommands);
      block = block.getNextBlock();
    }
  }

  function compileBlock(block, outCommands) {
    const id = block.id;
    const manifest = activeManifest();
    const robotId = manifest ? manifest.id : "arduino_arm";

    switch (block.type) {
      case "move_joint": {
        const joint = blockJoint(block, "JOINT");
        outCommands.push({
          type: "move_joint",
          robotId,
          joint: joint.id,
          value: normalizeJointValue(joint, block.getFieldValue("ANGLE"), 90),
          unit: "deg",
          speed: clamp(toInt(block.getFieldValue("SPEED"), 50), 1, 100),
          blockId: id
        });
        return;
      }

      case "move_arm": {
        const joints = {};
        const manifestJoints = manifest && Array.isArray(manifest.joints) ? manifest.joints : [];
        const speed = clamp(toInt(block.getFieldValue("SPEED"), 50), 1, 100);
        const count = manifestJoints.length || 6;
        for (let index = 0; index < count; index += 1) {
          const jointId = manifestJoints[index] ? manifestJoints[index].id : String(index);
          const fallback = manifestJoints[index] ? manifestJoints[index].home : 90;
          joints[jointId] = toFloat(block.getFieldValue(`A${index}`), fallback);
        }
        outCommands.push({ type: "move_joints", robotId, joints, unit: "deg", speed, blockId: id });
        return;
      }

      case "move_joint_pose": {
        const joints = {};
        let target = block.getInputTargetBlock("TARGETS");
        while (target) {
          if (target.type === "joint_target") {
            const joint = blockJoint(target, "JOINT");
            if (Object.prototype.hasOwnProperty.call(joints, joint.id)) {
              throw new Error(`Joint pose contains duplicate target: ${joint.id}.`);
            }
            const fallback = joint.joint ? joint.joint.home : 0;
            joints[joint.id] = normalizeJointValue(joint, target.getFieldValue("ANGLE"), fallback);
          }
          target = target.getNextBlock();
        }
        if (Object.keys(joints).length === 0) {
          throw new Error("Move joint pose requires at least one joint target.");
        }
        outCommands.push({
          type: "move_joints",
          robotId,
          joints,
          unit: "deg",
          speed: clamp(toInt(block.getFieldValue("SPEED"), 50), 1, 100),
          blockId: id
        });
        return;
      }

      case "joint_target":
        return;

      case "g1_posture":
        outCommands.push({
          type: "set_posture",
          robotId,
          posture: block.getFieldValue("POSTURE") || "neutral",
          seconds: clamp(toFloat(block.getFieldValue("SECONDS"), 0.8), 0.2, 10),
          blockId: id
        });
        return;

      case "g1_walk":
        outCommands.push({
          type: "humanoid_walk",
          robotId,
          direction: block.getFieldValue("DIRECTION") || "forward",
          steps: clamp(toInt(block.getFieldValue("STEPS"), 3), 1, 20),
          stepLengthM: clamp(toFloat(block.getFieldValue("STEP_LENGTH"), 0.08), 0.02, 0.12),
          speed: clamp(toInt(block.getFieldValue("SPEED"), 50), 1, 100),
          blockId: id
        });
        return;

      case "g1_turn":
        outCommands.push({
          type: "humanoid_turn",
          robotId,
          angleDeg: toFloat(block.getFieldValue("ANGLE"), 90),
          seconds: clamp(toFloat(block.getFieldValue("SECONDS"), 1.2), 0.2, 10),
          blockId: id
        });
        return;

      case "g1_pick":
        outCommands.push({ type: "pick_nearest", robotId, hand: block.getFieldValue("HAND") || "right_hand", blockId: id });
        return;

      case "g1_release":
        outCommands.push({ type: "release_object", robotId, hand: block.getFieldValue("HAND") || "right_hand", blockId: id });
        return;

      case "g1_demo":
        outCommands.push({ type: "run_demo", robotId, blockId: id });
        return;

      case "home_position":
        outCommands.push({ type: "home", robotId, blockId: id });
        return;

      case "gripper_open":
        outCommands.push({ type: "set_gripper", robotId, side: block.getFieldValue("SIDE") || "both", value: "open", speed: toInt(block.getFieldValue("SPEED"), GRIPPER_DEFAULT_SPEED), blockId: id });
        return;

      case "gripper_close":
        outCommands.push({ type: "set_gripper", robotId, side: block.getFieldValue("SIDE") || "both", value: "close", speed: toInt(block.getFieldValue("SPEED"), GRIPPER_DEFAULT_SPEED), blockId: id });
        return;

      case "wait_seconds":
        outCommands.push({ type: "wait", robotId, seconds: clamp(toFloat(block.getFieldValue("SECONDS"), 1), 0, 30), blockId: id });
        return;

      case "repeat_times": {
        const count = clamp(toInt(block.getFieldValue("COUNT"), 1), 1, 100);
        const body = block.getInputTargetBlock("DO");
        for (let i = 0; i < count; i += 1) {
          if (body) {
            compileChain(body, outCommands);
          }
        }
        return;
      }

      case "repeat_forever": {
        const body = block.getInputTargetBlock("DO");
        const inner = [];
        if (body) {
          compileChain(body, inner);
        }
        outCommands.push({ type: "loopForever", body: inner, blockId: id });
        return;
      }

      case "logic_if_simple": {
        if (block.getFieldValue("COND") === "TRUE") {
          const body = block.getInputTargetBlock("DO");
          if (body) {
            compileChain(body, outCommands);
          }
        }
        return;
      }

      case "save_pose": {
        const rawName = String(block.getFieldValue("NAME") || "Pose").trim();
        outCommands.push({ type: "savePose", name: rawName.length > 0 ? rawName.slice(0, 40) : "Pose", blockId: id });
        return;
      }

      case "go_to_pose": {
        const name = String(block.getFieldValue("NAME") || "").trim();
        if (name && name !== "__none__") {
          outCommands.push({ type: "goPose", name, speed: clamp(toInt(block.getFieldValue("SPEED"), 50), 1, 100), blockId: id });
        }
        return;
      }

      case "smooth_move": {
        const joint = blockJoint(block, "JOINT");
        outCommands.push({
          type: "smooth_move",
          robotId,
          joint: joint.id,
          from: normalizeJointValue(joint, block.getFieldValue("FROM"), 0),
          to: normalizeJointValue(joint, block.getFieldValue("TO"), 30),
          seconds: clamp(toFloat(block.getFieldValue("SECONDS"), 1.5), 0.2, 10),
          blockId: id
        });
        return;
      }

      case "emergency_stop":
      case "robot_stop":
        outCommands.push({ type: "stop", robotId, reason: "user", blockId: id });
        return;

      case "drive_forward":
        outCommands.push(driveCommand(robotId, id, block, 1, 0, 0));
        return;
      case "drive_backward":
        outCommands.push(driveCommand(robotId, id, block, -1, 0, 0));
        return;
      case "strafe_left":
        outCommands.push(driveCommand(robotId, id, block, 0, 1, 0));
        return;
      case "strafe_right":
        outCommands.push(driveCommand(robotId, id, block, 0, -1, 0));
        return;
      case "turn_left":
        outCommands.push(driveCommand(robotId, id, block, 0, 0, 1));
        return;
      case "turn_right":
        outCommands.push(driveCommand(robotId, id, block, 0, 0, -1));
        return;
      case "drive_for_seconds":
        outCommands.push(vectorDriveCommand(robotId, id, block));
        return;

      default:
        return;
    }
  }

  function validateGenerated(commands) {
    if (!NS.RobotCommandSchema) {
      return commands;
    }
    const validated = [];
    for (const command of commands) {
      if (command.type === "savePose" || command.type === "goPose" || command.type === "loopForever") {
        validated.push(command);
        continue;
      }
      const result = NS.RobotCommandSchema.validateCommand(command, { activeRobotId: activeManifest().id });
      if (!result.ok) {
        throw new Error(result.error);
      }
      validated.push(result.command);
    }
    return validated;
  }

  function fieldJoint(block, fieldName) {
    return blockJoint(block, fieldName).id;
  }

  function blockJoint(block, fieldName) {
    const value = block.getFieldValue(fieldName);
    const manifest = activeManifest();
    if (manifest && NS.RobotCommandSchema) {
      const joint = NS.RobotCommandSchema.resolveJoint(manifest, value);
      if (joint) {
        return { id: joint.id, joint, legacyIndex: null };
      }
    }
    const migrated = coerceLegacyJointForActiveManifest(manifest, value);
    if (migrated) {
      return migrated;
    }
    return { id: value, joint: null, legacyIndex: null };
  }

  function coerceLegacyJointForActiveManifest(manifest, value) {
    if (!manifest || manifest.id === "arduino_arm" || !Array.isArray(manifest.joints)) {
      return null;
    }
    const raw = String(value ?? "").trim();
    const numeric = Number.parseInt(raw, 10);
    if (Number.isInteger(numeric) && manifest.joints[numeric]) {
      return manifest.joints[numeric].id;
    }
    const normalized = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "");
    const legacyIndex = LEGACY_JOINT_ALIASES.has(normalized)
      ? LEGACY_JOINT_ALIASES.get(normalized)
      : LEGACY_JOINT_ORDER.indexOf(normalized);
    const joint = legacyIndex >= 0 ? manifest.joints[legacyIndex] : null;
    return joint
      ? { id: joint.id, joint, legacyIndex }
      : null;
  }

  function normalizeJointValue(jointInfo, rawValue, fallback) {
    const value = toFloat(rawValue, fallback);
    if (!jointInfo || jointInfo.legacyIndex === null || !jointInfo.joint) {
      return value;
    }
    return mapLegacyServoValue(jointInfo.legacyIndex, value, jointInfo.joint);
  }

  function mapLegacyServoValue(legacyIndex, value, targetJoint) {
    const sourceLimits = JOINT_LIMITS[legacyIndex] || [0, 180];
    const sourceMin = Number(sourceLimits[0]);
    const sourceMax = Number(sourceLimits[1]);
    const sourceHome = 90;
    const targetMin = Number(targetJoint.min);
    const targetMax = Number(targetJoint.max);
    const targetHome = Number.isFinite(Number(targetJoint.home))
      ? Number(targetJoint.home)
      : (targetMin + targetMax) / 2;
    if (
      !Number.isFinite(sourceMin) ||
      !Number.isFinite(sourceMax) ||
      !Number.isFinite(targetMin) ||
      !Number.isFinite(targetMax)
    ) {
      return value;
    }

    const sourceSpan = value >= sourceHome
      ? Math.max(1, sourceMax - sourceHome)
      : Math.max(1, sourceHome - sourceMin);
    const targetSpan = value >= sourceHome
      ? targetMax - targetHome
      : targetHome - targetMin;
    const ratio = (value - sourceHome) / sourceSpan;
    const mapped = targetHome + ratio * targetSpan;
    return Number(clamp(mapped, targetMin, targetMax).toFixed(2));
  }

  function driveCommand(robotId, blockId, block, xSign, ySign, omegaSign) {
    const manifest = activeManifest();
    const maxLinear = Number(manifest && manifest.mobileBase && manifest.mobileBase.maxLinearSpeed) || 1;
    const maxAngular = Number(manifest && manifest.mobileBase && manifest.mobileBase.maxAngularSpeed) || 90;
    const percent = clamp(toFloat(block.getFieldValue("SPEED"), 40), -100, 100) / 100;
    return {
      type: "drive",
      robotId,
      vx: xSign * Math.abs(percent) * maxLinear,
      vy: ySign * Math.abs(percent) * maxLinear,
      omega: omegaSign * Math.abs(percent) * maxAngular,
      seconds: clamp(toFloat(block.getFieldValue("SECONDS"), 1), 0, 30),
      frame: "robot",
      blockId
    };
  }

  function vectorDriveCommand(robotId, blockId, block) {
    const manifest = activeManifest();
    const maxLinear = Number(manifest && manifest.mobileBase && manifest.mobileBase.maxLinearSpeed) || 1;
    const maxAngular = Number(manifest && manifest.mobileBase && manifest.mobileBase.maxAngularSpeed) || 90;
    return {
      type: "drive",
      robotId,
      vx: clamp(toFloat(block.getFieldValue("SPEED"), 20), -100, 100) / 100 * maxLinear,
      vy: clamp(toFloat(block.getFieldValue("VY"), 0), -100, 100) / 100 * maxLinear,
      omega: clamp(toFloat(block.getFieldValue("OMEGA"), 0), -maxAngular, maxAngular),
      seconds: clamp(toFloat(block.getFieldValue("SECONDS"), 1), 0, 30),
      frame: "robot",
      blockId
    };
  }

  function toInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function toFloat(value, fallback) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  NS.Generator = {
    generateCommands,
    JOINT_LIMITS
  };
})();
