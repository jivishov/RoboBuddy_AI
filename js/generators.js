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
  const GRIPPER_SERVO = 5;
  const GRIPPER_OPEN_ANGLE = 50;
  const GRIPPER_CLOSE_ANGLE = 120;
  const GRIPPER_DEFAULT_SPEED = 55;

  function generateCommands(workspace) {
    if (!workspace) {
      return [];
    }

    const commands = [];
    const topBlocks = workspace.getTopBlocks(true);
    for (const block of topBlocks) {
      compileChain(block, commands);
    }

    return commands;
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

    switch (block.type) {
      case "move_joint": {
        const servo = clamp(toInt(block.getFieldValue("JOINT"), 0), 0, 5);
        const [min, max] = JOINT_LIMITS[servo];
        const angle = clamp(toInt(block.getFieldValue("ANGLE"), 90), min, max);
        const speed = clamp(toInt(block.getFieldValue("SPEED"), 50), 1, 100);
        outCommands.push({ type: "servo", servo, angle, speed, blockId: id });
        return;
      }

      case "move_arm": {
        const speed = clamp(toInt(block.getFieldValue("SPEED"), 50), 1, 100);
        for (let servo = 0; servo < 6; servo += 1) {
          const [min, max] = JOINT_LIMITS[servo];
          const angle = clamp(toInt(block.getFieldValue(`A${servo}`), 90), min, max);
          outCommands.push({ type: "servo", servo, angle, speed, blockId: id });
        }
        return;
      }

      case "home_position": {
        outCommands.push({ type: "home", blockId: id });
        return;
      }

      case "gripper_open": {
        const [min, max] = JOINT_LIMITS[GRIPPER_SERVO];
        const angle = clamp(GRIPPER_OPEN_ANGLE, min, max);
        const speed = clamp(toInt(block.getFieldValue("SPEED"), GRIPPER_DEFAULT_SPEED), 1, 100);
        outCommands.push({ type: "servo", servo: GRIPPER_SERVO, angle, speed, blockId: id });
        return;
      }

      case "gripper_close": {
        const [min, max] = JOINT_LIMITS[GRIPPER_SERVO];
        const angle = clamp(GRIPPER_CLOSE_ANGLE, min, max);
        const speed = clamp(toInt(block.getFieldValue("SPEED"), GRIPPER_DEFAULT_SPEED), 1, 100);
        outCommands.push({ type: "servo", servo: GRIPPER_SERVO, angle, speed, blockId: id });
        return;
      }

      case "wait_seconds": {
        const seconds = clamp(toFloat(block.getFieldValue("SECONDS"), 1), 0.1, 10);
        outCommands.push({ type: "delay", ms: Math.round(seconds * 1000), blockId: id });
        return;
      }

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
        const condition = block.getFieldValue("COND") === "TRUE";
        if (condition) {
          const body = block.getInputTargetBlock("DO");
          if (body) {
            compileChain(body, outCommands);
          }
        }
        return;
      }

      case "save_pose": {
        const rawName = String(block.getFieldValue("NAME") || "Pose").trim();
        const name = rawName.length > 0 ? rawName.slice(0, 40) : "Pose";
        outCommands.push({ type: "savePose", name, blockId: id });
        return;
      }

      case "go_to_pose": {
        const name = String(block.getFieldValue("NAME") || "").trim();
        const speed = clamp(toInt(block.getFieldValue("SPEED"), 50), 1, 100);
        if (name && name !== "__none__") {
          outCommands.push({ type: "goPose", name, speed, blockId: id });
        }
        return;
      }

      case "smooth_move": {
        const servo = clamp(toInt(block.getFieldValue("JOINT"), 0), 0, 5);
        const [min, max] = JOINT_LIMITS[servo];
        const from = clamp(toInt(block.getFieldValue("FROM"), 90), min, max);
        const to = clamp(toInt(block.getFieldValue("TO"), 120), min, max);
        const seconds = clamp(toFloat(block.getFieldValue("SECONDS"), 1.5), 0.2, 10);

        outCommands.push({
          type: "smoothMove",
          servo,
          from,
          to,
          durationMs: Math.round(seconds * 1000),
          blockId: id
        });
        return;
      }

      case "emergency_stop": {
        outCommands.push({ type: "emergencyStop", blockId: id });
        return;
      }

      default:
        return;
    }
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
