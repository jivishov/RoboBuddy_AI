(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const COLORS = {
    movement: "#8e44ad",
    flow: "#d4ac0d",
    logic: "#2471a3",
    pose: "#1f9d55",
    advanced: "#d97706",
    mobile: "#0b7a75"
  };

  const DEFAULT_JOINT_LIMITS = [
    [20, 130],
    [15, 165],
    [0, 180],
    [0, 180],
    [0, 180],
    [25, 130]
  ];

  const LEGACY_JOINT_OPTIONS = [
    ["Base", "0"],
    ["Shoulder", "1"],
    ["Elbow", "2"],
    ["Wrist Rot", "3"],
    ["Wrist Tilt", "4"],
    ["Gripper", "5"]
  ];

  const DEFAULT_GRIPPER_SPEED = 55;
  let registered = false;

  function createTheme() {
    const blockStyles = {
      movement_style: { colourPrimary: COLORS.movement, colourSecondary: "#7d3c9b", colourTertiary: "#6c3489" },
      flow_style: { colourPrimary: COLORS.flow, colourSecondary: "#c09b0c", colourTertiary: "#a8880a" },
      logic_style: { colourPrimary: COLORS.logic, colourSecondary: "#1f6391", colourTertiary: "#1a557d" },
      pose_style: { colourPrimary: COLORS.pose, colourSecondary: "#1b8b4b", colourTertiary: "#177941" },
      advanced_style: { colourPrimary: COLORS.advanced, colourSecondary: "#c36a05", colourTertiary: "#ab5d05" },
      mobile_style: { colourPrimary: COLORS.mobile, colourSecondary: "#09635f", colourTertiary: "#064f4c" }
    };

    const categoryStyles = {
      movement_category: { colour: COLORS.movement },
      flow_category: { colour: COLORS.flow },
      logic_category: { colour: COLORS.logic },
      pose_category: { colour: COLORS.pose },
      advanced_category: { colour: COLORS.advanced },
      mobile_category: { colour: COLORS.mobile }
    };

    const componentStyles = {
      workspaceBackgroundColour: "#f0f4fa",
      toolboxBackgroundColour: "#ffffff",
      toolboxForegroundColour: "#1e2430",
      flyoutBackgroundColour: "#f5f7ff",
      flyoutForegroundColour: "#1e2430",
      flyoutOpacity: 0.96,
      scrollbarColour: "#c4cdd9",
      scrollbarOpacity: 0.6,
      insertionMarkerColour: "#0b7a75",
      insertionMarkerOpacity: 0.4,
      cursorColour: "#0b7a75"
    };

    return Blockly.Theme.defineTheme("roboadmin", {
      name: "roboadmin",
      blockStyles,
      categoryStyles,
      componentStyles,
      fontStyle: {
        family: '"DM Sans", sans-serif',
        weight: "500",
        size: 11
      },
      startHats: false
    });
  }

  function activeManifest() {
    return NS.RobotRegistry && NS.RobotRegistry.getActive
      ? NS.RobotRegistry.getActive()
      : null;
  }

  function activeJoints() {
    const manifest = activeManifest();
    return manifest && Array.isArray(manifest.joints) && manifest.joints.length > 0
      ? manifest.joints
      : null;
  }

  function getJointOptions() {
    const joints = activeJoints();
    if (!joints) {
      return LEGACY_JOINT_OPTIONS;
    }
    return joints.map((joint, index) => [joint.label || joint.id, joint.id || String(index)]);
  }

  function getJointLimits() {
    const joints = activeJoints();
    if (!joints) {
      return DEFAULT_JOINT_LIMITS;
    }
    return joints.map((joint) => [Number(joint.min), Number(joint.max)]);
  }

  function getGripperSideOptions() {
    const joints = activeJoints() || [];
    const grippers = joints.filter((joint) => joint.type === "gripper");
    if (grippers.length <= 1) {
      return [["gripper", "both"]];
    }
    return [["both grippers", "both"], ["left gripper", "left"], ["right gripper", "right"]];
  }

  function globalJointMin() {
    return Math.min(...getJointLimits().map((limits) => Number(limits[0])));
  }

  function globalJointMax() {
    return Math.max(...getJointLimits().map((limits) => Number(limits[1])));
  }

  function registerBlocks() {
    if (registered) {
      return;
    }

    Blockly.Blocks.move_joint = {
      init() {
        this.appendDummyInput()
          .appendField("Move")
          .appendField(new Blockly.FieldDropdown(getJointOptions), "JOINT")
          .appendField("to")
          .appendField(new Blockly.FieldNumber(homeFor(0), globalJointMin(), globalJointMax(), 1), "ANGLE")
          .appendField("speed")
          .appendField(new Blockly.FieldNumber(50, 1, 100, 1), "SPEED");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
        this.setTooltip("Move one active robot joint within its manifest limits.");
      }
    };

    Blockly.Blocks.move_arm = {
      init() {
        const joints = activeJoints() || [];
        const limits = getJointLimits();
        const labels = (joints.length ? joints : LEGACY_JOINT_OPTIONS.map(([label]) => ({ label }))).slice(0, 6);
        this.appendDummyInput()
          .appendField("Move all joints")
          .appendField(labels[0] ? labels[0].label : "Joint 1")
          .appendField(new Blockly.FieldNumber(homeFor(0), limitMin(limits, 0), limitMax(limits, 0), 1), "A0")
          .appendField(labels[1] ? labels[1].label : "Joint 2")
          .appendField(new Blockly.FieldNumber(homeFor(1), limitMin(limits, 1), limitMax(limits, 1), 1), "A1");

        this.appendDummyInput()
          .appendField(labels[2] ? labels[2].label : "Joint 3")
          .appendField(new Blockly.FieldNumber(homeFor(2), limitMin(limits, 2), limitMax(limits, 2), 1), "A2")
          .appendField(labels[3] ? labels[3].label : "Joint 4")
          .appendField(new Blockly.FieldNumber(homeFor(3), limitMin(limits, 3), limitMax(limits, 3), 1), "A3")
          .appendField(labels[4] ? labels[4].label : "Joint 5")
          .appendField(new Blockly.FieldNumber(homeFor(4), limitMin(limits, 4), limitMax(limits, 4), 1), "A4");

        this.appendDummyInput()
          .appendField(labels[5] ? labels[5].label : "Joint 6")
          .appendField(new Blockly.FieldNumber(homeFor(5), limitMin(limits, 5), limitMax(limits, 5), 1), "A5")
          .appendField("speed")
          .appendField(new Blockly.FieldNumber(50, 1, 100, 1), "SPEED");

        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
        this.setTooltip("Move the active robot joints to a pose.");
      }
    };

    Blockly.Blocks.joint_target = {
      init() {
        this.appendDummyInput()
          .appendField(new Blockly.FieldDropdown(getJointOptions), "JOINT")
          .appendField("to")
          .appendField(new Blockly.FieldNumber(homeFor(0), globalJointMin(), globalJointMax(), 0.5), "ANGLE")
          .appendField("deg");
        this.setPreviousStatement(true, "JointTarget");
        this.setNextStatement(true, "JointTarget");
        this.setStyle("movement_style");
        this.setTooltip("Add one named joint target to a scalable robot pose.");
      }
    };

    Blockly.Blocks.move_joint_pose = {
      init() {
        this.appendDummyInput()
          .appendField("Move joint pose at speed")
          .appendField(new Blockly.FieldNumber(50, 1, 100, 1), "SPEED");
        this.appendStatementInput("TARGETS")
          .setCheck("JointTarget")
          .appendField("targets");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
        this.setTooltip("Move any subset of the active robot's joints.");
      }
    };

    Blockly.Blocks.g1_posture = {
      init() {
        this.appendDummyInput()
          .appendField("G1 posture")
          .appendField(new Blockly.FieldDropdown(getPostureOptions), "POSTURE")
          .appendField("in")
          .appendField(new Blockly.FieldNumber(0.8, 0.2, 10, 0.1), "SECONDS")
          .appendField("s");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
      }
    };

    Blockly.Blocks.g1_walk = {
      init() {
        this.appendDummyInput()
          .appendField("G1 walk")
          .appendField(new Blockly.FieldDropdown([["forward", "forward"], ["backward", "backward"]]), "DIRECTION")
          .appendField(new Blockly.FieldNumber(3, 1, 20, 1), "STEPS")
          .appendField("steps of")
          .appendField(new Blockly.FieldNumber(0.08, 0.02, 0.12, 0.01), "STEP_LENGTH")
          .appendField("m at")
          .appendField(new Blockly.FieldNumber(50, 1, 100, 1), "SPEED")
          .appendField("%");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
      }
    };

    Blockly.Blocks.g1_turn = {
      init() {
        this.appendDummyInput()
          .appendField("G1 turn")
          .appendField(new Blockly.FieldNumber(90, -180, 180, 1), "ANGLE")
          .appendField("deg in")
          .appendField(new Blockly.FieldNumber(1.2, 0.2, 10, 0.1), "SECONDS")
          .appendField("s");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
      }
    };

    Blockly.Blocks.g1_pick = {
      init() {
        this.appendDummyInput()
          .appendField("G1 pick nearest with")
          .appendField(new Blockly.FieldDropdown(getHandOptions), "HAND");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("pose_style");
      }
    };

    Blockly.Blocks.g1_release = {
      init() {
        this.appendDummyInput()
          .appendField("G1 release from")
          .appendField(new Blockly.FieldDropdown(getHandOptions), "HAND");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("pose_style");
      }
    };

    Blockly.Blocks.g1_demo = {
      init() {
        this.appendDummyInput().appendField("Run G1 walk, grab, return demo");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("advanced_style");
      }
    };

    Blockly.Blocks.home_position = {
      init() {
        this.appendDummyInput().appendField("Home Position");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
      }
    };

    Blockly.Blocks.gripper_open = {
      init() {
        this.appendDummyInput()
          .appendField("Open")
          .appendField(new Blockly.FieldDropdown(getGripperSideOptions), "SIDE")
          .appendField("speed")
          .appendField(new Blockly.FieldNumber(DEFAULT_GRIPPER_SPEED, 1, 100, 1), "SPEED");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
      }
    };

    Blockly.Blocks.gripper_close = {
      init() {
        this.appendDummyInput()
          .appendField("Close")
          .appendField(new Blockly.FieldDropdown(getGripperSideOptions), "SIDE")
          .appendField("speed")
          .appendField(new Blockly.FieldNumber(DEFAULT_GRIPPER_SPEED, 1, 100, 1), "SPEED");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
      }
    };

    Blockly.Blocks.wait_seconds = {
      init() {
        this.appendDummyInput()
          .appendField("Wait")
          .appendField(new Blockly.FieldNumber(1, 0, 30, 0.1), "SECONDS")
          .appendField("seconds");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("flow_style");
      }
    };

    Blockly.Blocks.repeat_times = {
      init() {
        this.appendDummyInput()
          .appendField("Repeat")
          .appendField(new Blockly.FieldNumber(3, 1, 100, 1), "COUNT")
          .appendField("times");
        this.appendStatementInput("DO").appendField("do");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("flow_style");
      }
    };

    Blockly.Blocks.repeat_forever = {
      init() {
        this.appendDummyInput().appendField("Repeat Forever");
        this.appendStatementInput("DO").appendField("do");
        this.setPreviousStatement(true, null);
        this.setNextStatement(false, null);
        this.setStyle("flow_style");
      }
    };

    Blockly.Blocks.logic_if_simple = {
      init() {
        this.appendDummyInput()
          .appendField("If")
          .appendField(new Blockly.FieldDropdown([["true", "TRUE"], ["false", "FALSE"]]), "COND");
        this.appendStatementInput("DO").appendField("do");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("logic_style");
      }
    };

    Blockly.Blocks.save_pose = {
      init() {
        this.appendDummyInput()
          .appendField("Save Pose")
          .appendField(new Blockly.FieldTextInput("Pose 1"), "NAME");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("pose_style");
      }
    };

    Blockly.Blocks.go_to_pose = {
      init() {
        this.appendDummyInput()
          .appendField("Go To Pose")
          .appendField(new Blockly.FieldDropdown(getPoseOptions), "NAME")
          .appendField("speed")
          .appendField(new Blockly.FieldNumber(50, 1, 100, 1), "SPEED");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("pose_style");
      }
    };

    Blockly.Blocks.smooth_move = {
      init() {
        this.appendDummyInput()
          .appendField("Smooth Move")
          .appendField(new Blockly.FieldDropdown(getJointOptions), "JOINT")
          .appendField("from")
          .appendField(new Blockly.FieldNumber(0, -180, 180, 1), "FROM")
          .appendField("to")
          .appendField(new Blockly.FieldNumber(30, -180, 180, 1), "TO")
          .appendField("duration")
          .appendField(new Blockly.FieldNumber(1.5, 0.2, 10, 0.1), "SECONDS")
          .appendField("s");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("advanced_style");
      }
    };

    Blockly.Blocks.emergency_stop = {
      init() {
        this.appendDummyInput().appendField("Emergency Stop");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("advanced_style");
      }
    };

    registerDriveBlock("drive_forward", "Drive forward", "FORWARD");
    registerDriveBlock("drive_backward", "Drive backward", "BACKWARD");
    registerDriveBlock("strafe_left", "Strafe left", "STRAFE_LEFT");
    registerDriveBlock("strafe_right", "Strafe right", "STRAFE_RIGHT");
    registerDriveBlock("turn_left", "Turn left", "TURN_LEFT");
    registerDriveBlock("turn_right", "Turn right", "TURN_RIGHT");
    registerDriveBlock("drive_for_seconds", "Drive vector", "VECTOR");
    registerDriveBlock("robot_stop", "Robot Stop", "STOP");

    registered = true;
  }

  function registerDriveBlock(type, label, mode) {
    Blockly.Blocks[type] = {
      init() {
        this.appendDummyInput()
          .appendField(label)
          .appendField(new Blockly.FieldNumber(mode === "VECTOR" ? 20 : 40, -100, 100, 1), "SPEED")
          .appendField(mode === "VECTOR" ? "vx %" : "speed %")
          .appendField(new Blockly.FieldNumber(1, 0, 30, 0.1), "SECONDS")
          .appendField("s");
        if (mode === "VECTOR") {
          this.appendDummyInput()
            .appendField("vy %")
            .appendField(new Blockly.FieldNumber(0, -100, 100, 1), "VY")
            .appendField("omega deg/s")
            .appendField(new Blockly.FieldNumber(0, -90, 90, 1), "OMEGA");
        }
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("mobile_style");
      }
    };
  }

  function getPoseOptions() {
    const names = typeof NS.getPoseNames === "function" ? NS.getPoseNames() : [];
    return Array.isArray(names) && names.length > 0 ? names.map((name) => [name, name]) : [["No poses", "__none__"]];
  }

  function getPostureOptions() {
    const manifest = activeManifest();
    const postures = manifest && manifest.postures && typeof manifest.postures === "object"
      ? Object.entries(manifest.postures)
      : [];
    return postures.length > 0
      ? postures.map(([id, posture]) => [posture.label || id, id])
      : [["neutral", "neutral"]];
  }

  function getHandOptions() {
    const manifest = activeManifest();
    const hands = manifest && manifest.humanoid && Array.isArray(manifest.humanoid.hands)
      ? manifest.humanoid.hands
      : ["left_hand", "right_hand"];
    return hands.map((id) => [id.replace(/_/g, " "), id]);
  }

  function toolboxXml(robotId) {
    const manifest = robotId && NS.RobotRegistry ? NS.RobotRegistry.get(robotId) : activeManifest();
    const capabilities = new Set(manifest && Array.isArray(manifest.capabilities) ? manifest.capabilities : []);
    const showArm = capabilities.has("joint_control");
    const showGripper = capabilities.has("gripper");
    const showMobile = capabilities.has("drive_2d") || capabilities.has("holonomic_drive");
    const scalablePose = Boolean(manifest && Array.isArray(manifest.joints) && manifest.joints.length > 12);
    const movementBlocks = [
      showArm ? "<block type=\"move_joint\"></block>" : "",
      showArm && capabilities.has("multi_joint_pose") && scalablePose ? "<block type=\"move_joint_pose\"><statement name=\"TARGETS\"><block type=\"joint_target\"></block></statement></block><block type=\"joint_target\"></block>" : "",
      showArm && capabilities.has("multi_joint_pose") && !scalablePose ? "<block type=\"move_arm\"></block>" : "",
      capabilities.has("home") ? "<block type=\"home_position\"></block>" : "",
      showGripper ? "<block type=\"gripper_open\"></block><block type=\"gripper_close\"></block>" : ""
    ].join("");
    const humanoidCategory = capabilities.has("humanoid_walk") ? `
      <category name="Humanoid" categorystyle="movement_category">
        <block type="g1_posture"></block>
        <block type="g1_walk"></block>
        <block type="g1_turn"></block>
        <block type="g1_pick"></block>
        <block type="g1_release"></block>
        <block type="g1_demo"></block>
      </category>
    ` : "";
    const mobileCategory = showMobile ? `
      <category name="Mobile Base" categorystyle="mobile_category">
        <block type="drive_forward"></block>
        <block type="drive_backward"></block>
        <block type="strafe_left"></block>
        <block type="strafe_right"></block>
        <block type="turn_left"></block>
        <block type="turn_right"></block>
        <block type="drive_for_seconds"></block>
        <block type="robot_stop"></block>
      </category>
    ` : "";

    return `
      <category name="Movement" categorystyle="movement_category">
        ${movementBlocks}
      </category>
      ${humanoidCategory}
      ${mobileCategory}
      <category name="Flow" categorystyle="flow_category">
        <block type="wait_seconds"></block>
        <block type="repeat_times"></block>
        <block type="repeat_forever"></block>
      </category>
      <category name="Logic" categorystyle="logic_category">
        <block type="logic_if_simple"></block>
      </category>
      <category name="Pose" categorystyle="pose_category">
        <block type="save_pose"></block>
        <block type="go_to_pose"></block>
      </category>
      <category name="Advanced" categorystyle="advanced_category">
        <block type="smooth_move"></block>
        <block type="emergency_stop"></block>
      </category>
    `;
  }

  function refreshToolbox(workspace, toolboxEl) {
    const xml = toolboxXml();
    let toolboxSource = toolboxEl || null;
    if (toolboxSource) {
      toolboxEl.innerHTML = xml;
    } else if (typeof document !== "undefined" && typeof document.createElement === "function") {
      toolboxSource = document.createElement("xml");
      toolboxSource.innerHTML = xml;
    }
    if (workspace && typeof workspace.updateToolbox === "function") {
      workspace.updateToolbox(toolboxSource || `<xml>${xml}</xml>`);
    }
  }

  function limitMin(limits, index) {
    return limits[index] ? Number(limits[index][0]) : -180;
  }

  function limitMax(limits, index) {
    return limits[index] ? Number(limits[index][1]) : 180;
  }

  function homeFor(index) {
    const joints = activeJoints();
    return joints && joints[index] ? Number(joints[index].home) || 0 : 90;
  }

  NS.Blocks = {
    registerBlocks,
    toolboxXml,
    refreshToolbox,
    createTheme,
    JOINT_OPTIONS: LEGACY_JOINT_OPTIONS,
    JOINT_LIMITS: DEFAULT_JOINT_LIMITS,
    getJointOptions,
    getJointLimits
  };
})();
