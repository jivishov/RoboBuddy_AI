(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const GRIPPER_DEFAULT_SPEED = 55;

  function activeManifest() {
    return NS.RobotRegistry && NS.RobotRegistry.getActive
      ? NS.RobotRegistry.getActive()
      : null;
  }

  function emit(workspace) {
    if (!workspace) {
      return { code: "", warnings: [] };
    }

    const manifest = activeManifest();
    const warnings = [];
    const lines = [
      "# RoboBuddy Python",
      "# Build safe robot commands with the robot API.",
      ""
    ];

    const topBlocks = workspace.getTopBlocks(true);
    for (const block of topBlocks) {
      emitChain(block, lines, 0, warnings);
      if (lines[lines.length - 1] !== "") {
        lines.push("");
      }
    }

    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    if (manifest && manifest.id === "arduino_arm") {
      warnings.push("The legacy arm.* API remains available for Arduino arm programs.");
    }

    return { code: lines.join("\n"), warnings };
  }

  function emitChain(startBlock, lines, indentLevel, warnings) {
    let block = startBlock;
    while (block) {
      emitBlock(block, lines, indentLevel, warnings);
      block = block.getNextBlock();
    }
  }

  function emitBlock(block, lines, indentLevel, warnings) {
    const pad = indent(indentLevel);

    switch (block.type) {
      case "move_joint": {
        lines.push(`${pad}robot.move_joint(${pythonString(fieldJoint(block, "JOINT"))}, ${toFloat(block.getFieldValue("ANGLE"), 90)}, speed=${toInt(block.getFieldValue("SPEED"), 50)})`);
        return;
      }

      case "move_arm": {
        const manifest = activeManifest();
        const joints = manifest && Array.isArray(manifest.joints) ? manifest.joints : [];
        const fields = [];
        const count = joints.length || 6;
        for (let index = 0; index < count; index += 1) {
          const jointId = joints[index] ? joints[index].id : String(index);
          const fallback = joints[index] ? joints[index].home : 90;
          fields.push(`${pythonString(jointId)}: ${toFloat(block.getFieldValue(`A${index}`), fallback)}`);
        }
        lines.push(`${pad}robot.move_joints({${fields.join(", ")}}, speed=${toInt(block.getFieldValue("SPEED"), 50)})`);
        return;
      }

      case "move_joint_pose": {
        const fields = [];
        const seen = new Set();
        let target = block.getInputTargetBlock("TARGETS");
        while (target) {
          if (target.type === "joint_target") {
            const jointId = fieldJoint(target, "JOINT");
            if (seen.has(jointId)) {
              throw new Error(`Joint pose contains duplicate target: ${jointId}.`);
            }
            seen.add(jointId);
            fields.push(`${pythonString(jointId)}: ${toFloat(target.getFieldValue("ANGLE"), 0)}`);
          }
          target = target.getNextBlock();
        }
        if (fields.length === 0) {
          throw new Error("Move joint pose requires at least one joint target.");
        }
        lines.push(`${pad}robot.move_joints({${fields.join(", ")}}, speed=${toInt(block.getFieldValue("SPEED"), 50)})`);
        return;
      }

      case "joint_target":
        warnings.push("A Joint Target must be placed inside a Move Joint Pose block.");
        return;

      case "g1_posture":
        lines.push(`${pad}robot.set_posture(${pythonString(block.getFieldValue("POSTURE") || "neutral")}, seconds=${formatSeconds(toFloat(block.getFieldValue("SECONDS"), 0.8))})`);
        return;

      case "g1_walk":
        lines.push(`${pad}robot.walk(${pythonString(block.getFieldValue("DIRECTION") || "forward")}, steps=${toInt(block.getFieldValue("STEPS"), 3)}, step_length=${toFloat(block.getFieldValue("STEP_LENGTH"), 0.08)}, speed=${toInt(block.getFieldValue("SPEED"), 50)})`);
        return;

      case "g1_turn":
        lines.push(`${pad}robot.turn(${toFloat(block.getFieldValue("ANGLE"), 90)}, seconds=${formatSeconds(toFloat(block.getFieldValue("SECONDS"), 1.2))})`);
        return;

      case "g1_pick":
        lines.push(`${pad}robot.pick_nearest(${pythonString(block.getFieldValue("HAND") || "right_hand")})`);
        return;

      case "g1_release":
        lines.push(`${pad}robot.release(${pythonString(block.getFieldValue("HAND") || "right_hand")})`);
        return;

      case "g1_demo":
        lines.push(`${pad}robot.run_demo()`);
        return;

      case "home_position":
        lines.push(`${pad}robot.home()`);
        return;

      case "gripper_open":
        lines.push(`${pad}robot.open_gripper(speed=${toInt(block.getFieldValue("SPEED"), GRIPPER_DEFAULT_SPEED)}, side=${pythonString(block.getFieldValue("SIDE") || "both")})`);
        return;

      case "gripper_close":
        lines.push(`${pad}robot.close_gripper(speed=${toInt(block.getFieldValue("SPEED"), GRIPPER_DEFAULT_SPEED)}, side=${pythonString(block.getFieldValue("SIDE") || "both")})`);
        return;

      case "wait_seconds":
        lines.push(`${pad}robot.wait(${formatSeconds(toFloat(block.getFieldValue("SECONDS"), 1))})`);
        return;

      case "repeat_times": {
        const count = clamp(toInt(block.getFieldValue("COUNT"), 1), 1, 100);
        const body = block.getInputTargetBlock("DO");
        lines.push(`${pad}for _ in range(${count}):`);
        emitBodyOrPass(body, lines, indentLevel + 1, warnings);
        return;
      }

      case "repeat_forever":
        throw new Error("Repeat Forever cannot be converted to Python code. Use Repeat N times for finite Python execution.");

      case "logic_if_simple": {
        const condition = block.getFieldValue("COND") === "TRUE";
        const body = block.getInputTargetBlock("DO");
        lines.push(`${pad}if ${condition ? "True" : "False"}:`);
        emitBodyOrPass(body, lines, indentLevel + 1, warnings);
        return;
      }

      case "save_pose": {
        const rawName = String(block.getFieldValue("NAME") || "Pose").trim();
        const name = rawName.length > 0 ? rawName.slice(0, 40) : "Pose";
        lines.push(`${pad}robot.save_pose(${pythonString(name)})`);
        return;
      }

      case "go_to_pose": {
        const name = String(block.getFieldValue("NAME") || "").trim();
        const speed = toInt(block.getFieldValue("SPEED"), 50);
        if (name && name !== "__none__") {
          lines.push(`${pad}robot.go_to_pose(${pythonString(name)}, speed=${speed})`);
        } else {
          warnings.push("Go To Pose block has no saved pose selected and was skipped.");
        }
        return;
      }

      case "smooth_move": {
        const seconds = formatSeconds(toFloat(block.getFieldValue("SECONDS"), 1.5));
        lines.push(`${pad}robot.smooth_move(${pythonString(fieldJoint(block, "JOINT"))}, ${toFloat(block.getFieldValue("FROM"), 0)}, ${toFloat(block.getFieldValue("TO"), 30)}, seconds=${seconds})`);
        return;
      }

      case "emergency_stop":
      case "robot_stop":
        lines.push(`${pad}robot.stop()`);
        return;

      case "drive_forward":
        lines.push(`${pad}robot.drive_forward(${toFloat(block.getFieldValue("SPEED"), 40)}, seconds=${formatSeconds(toFloat(block.getFieldValue("SECONDS"), 1))})`);
        return;
      case "drive_backward":
        lines.push(`${pad}robot.drive_backward(${toFloat(block.getFieldValue("SPEED"), 40)}, seconds=${formatSeconds(toFloat(block.getFieldValue("SECONDS"), 1))})`);
        return;
      case "strafe_left":
        lines.push(`${pad}robot.strafe_left(${toFloat(block.getFieldValue("SPEED"), 40)}, seconds=${formatSeconds(toFloat(block.getFieldValue("SECONDS"), 1))})`);
        return;
      case "strafe_right":
        lines.push(`${pad}robot.strafe_right(${toFloat(block.getFieldValue("SPEED"), 40)}, seconds=${formatSeconds(toFloat(block.getFieldValue("SECONDS"), 1))})`);
        return;
      case "turn_left":
        lines.push(`${pad}robot.turn_left(${toFloat(block.getFieldValue("SPEED"), 45)}, seconds=${formatSeconds(toFloat(block.getFieldValue("SECONDS"), 1))})`);
        return;
      case "turn_right":
        lines.push(`${pad}robot.turn_right(${toFloat(block.getFieldValue("SPEED"), 45)}, seconds=${formatSeconds(toFloat(block.getFieldValue("SECONDS"), 1))})`);
        return;
      case "drive_for_seconds":
        lines.push(`${pad}robot.drive(${toFloat(block.getFieldValue("SPEED"), 20)}, ${toFloat(block.getFieldValue("VY"), 0)}, ${toFloat(block.getFieldValue("OMEGA"), 0)}, seconds=${formatSeconds(toFloat(block.getFieldValue("SECONDS"), 1))})`);
        return;

      default:
        warnings.push(`Skipped unsupported block type: ${block.type}`);
    }
  }

  function emitBodyOrPass(body, lines, indentLevel, warnings) {
    if (!body) {
      lines.push(`${indent(indentLevel)}pass`);
      return;
    }
    emitChain(body, lines, indentLevel, warnings);
  }

  function fieldJoint(block, fieldName) {
    const value = block.getFieldValue(fieldName);
    const manifest = activeManifest();
    if (manifest && NS.RobotCommandSchema) {
      const joint = NS.RobotCommandSchema.resolveJoint(manifest, value);
      if (joint) {
        return joint.id;
      }
    }
    return value;
  }

  function indent(level) {
    return "  ".repeat(Math.max(0, level));
  }

  function pythonString(value) {
    return JSON.stringify(String(value));
  }

  function formatSeconds(value) {
    const n = Number.isFinite(value) ? value : 1;
    return String(Math.round(n * 100) / 100).replace(/\.0$/, "");
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

  NS.PythonEmitter = { emit };
})();
