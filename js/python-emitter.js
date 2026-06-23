(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const JOINT_NAMES = ["base", "shoulder", "elbow", "wrist_rot", "wrist_tilt", "gripper"];
  const GRIPPER_DEFAULT_SPEED = 55;

  function emit(workspace) {
    if (!workspace) {
      return {
        code: "",
        warnings: []
      };
    }

    const warnings = [];
    const lines = [
      "# RoboBuddy Python",
      "# Build motion commands with the safe arm API.",
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

    return {
      code: lines.join("\n"),
      warnings
    };
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
        const servo = clamp(toInt(block.getFieldValue("JOINT"), 0), 0, 5);
        const angle = toInt(block.getFieldValue("ANGLE"), 90);
        const speed = toInt(block.getFieldValue("SPEED"), 50);
        lines.push(`${pad}arm.move_joint(${pythonString(JOINT_NAMES[servo])}, ${angle}, speed=${speed})`);
        return;
      }

      case "move_arm": {
        const fields = [];
        for (let servo = 0; servo < 6; servo += 1) {
          fields.push(`${JOINT_NAMES[servo]}=${toInt(block.getFieldValue(`A${servo}`), 90)}`);
        }
        fields.push(`speed=${toInt(block.getFieldValue("SPEED"), 50)}`);
        lines.push(`${pad}arm.move_arm(${fields.join(", ")})`);
        return;
      }

      case "home_position":
        lines.push(`${pad}arm.home()`);
        return;

      case "gripper_open":
        lines.push(`${pad}arm.gripper_open(speed=${toInt(block.getFieldValue("SPEED"), GRIPPER_DEFAULT_SPEED)})`);
        return;

      case "gripper_close":
        lines.push(`${pad}arm.gripper_close(speed=${toInt(block.getFieldValue("SPEED"), GRIPPER_DEFAULT_SPEED)})`);
        return;

      case "wait_seconds":
        lines.push(`${pad}arm.wait(${formatSeconds(toFloat(block.getFieldValue("SECONDS"), 1))})`);
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
        lines.push(`${pad}arm.save_pose(${pythonString(name)})`);
        return;
      }

      case "go_to_pose": {
        const name = String(block.getFieldValue("NAME") || "").trim();
        const speed = toInt(block.getFieldValue("SPEED"), 50);
        if (name && name !== "__none__") {
          lines.push(`${pad}arm.go_to_pose(${pythonString(name)}, speed=${speed})`);
        } else {
          warnings.push("Go To Pose block has no saved pose selected and was skipped.");
        }
        return;
      }

      case "smooth_move": {
        const servo = clamp(toInt(block.getFieldValue("JOINT"), 0), 0, 5);
        const from = toInt(block.getFieldValue("FROM"), 90);
        const to = toInt(block.getFieldValue("TO"), 120);
        const seconds = formatSeconds(toFloat(block.getFieldValue("SECONDS"), 1.5));
        lines.push(`${pad}arm.smooth_move(${pythonString(JOINT_NAMES[servo])}, ${from}, ${to}, seconds=${seconds})`);
        return;
      }

      case "emergency_stop":
        lines.push(`${pad}arm.emergency_stop()`);
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

  function indent(level) {
    return "  ".repeat(Math.max(0, level));
  }

  function pythonString(value) {
    return JSON.stringify(String(value));
  }

  function formatSeconds(value) {
    const n = Number.isFinite(value) ? value : 1;
    const rounded = Math.round(n * 100) / 100;
    return String(rounded).replace(/\.0$/, "");
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

  NS.PythonEmitter = {
    emit
  };
})();
