(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});

  const COLORS = {
    movement: "#8e44ad",
    flow: "#d4ac0d",
    logic: "#2471a3",
    pose: "#1f9d55",
    advanced: "#d97706"
  };

  const DEFAULT_JOINT_LIMITS = [
    [20, 130],
    [15, 165],
    [0, 180],
    [0, 180],
    [0, 180],
    [25, 130]
  ];

  function createTheme() {
    var blockStyles = {
      movement_style: {
        colourPrimary: COLORS.movement,
        colourSecondary: "#7d3c9b",
        colourTertiary: "#6c3489"
      },
      flow_style: {
        colourPrimary: COLORS.flow,
        colourSecondary: "#c09b0c",
        colourTertiary: "#a8880a"
      },
      logic_style: {
        colourPrimary: COLORS.logic,
        colourSecondary: "#1f6391",
        colourTertiary: "#1a557d"
      },
      pose_style: {
        colourPrimary: COLORS.pose,
        colourSecondary: "#1b8b4b",
        colourTertiary: "#177941"
      },
      advanced_style: {
        colourPrimary: COLORS.advanced,
        colourSecondary: "#c36a05",
        colourTertiary: "#ab5d05"
      }
    };

    var categoryStyles = {
      movement_category: { colour: COLORS.movement },
      flow_category: { colour: COLORS.flow },
      logic_category: { colour: COLORS.logic },
      pose_category: { colour: COLORS.pose },
      advanced_category: { colour: COLORS.advanced }
    };

    var componentStyles = {
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

    var fontStyle = {
      family: '"DM Sans", sans-serif',
      weight: "500",
      size: 11
    };

    return Blockly.Theme.defineTheme("roboadmin", {
      name: "roboadmin",
      blockStyles: blockStyles,
      categoryStyles: categoryStyles,
      componentStyles: componentStyles,
      fontStyle: fontStyle,
      startHats: false
    });
  }

  const JOINT_OPTIONS = [
    ["Base", "0"],
    ["Shoulder", "1"],
    ["Elbow", "2"],
    ["Wrist Rot", "3"],
    ["Wrist Tilt", "4"],
    ["Gripper", "5"]
  ];
  const DEFAULT_GRIPPER_SPEED = 55;

  let registered = false;

  function getJointLimits() {
    if (!NS.Generator || !Array.isArray(NS.Generator.JOINT_LIMITS) || NS.Generator.JOINT_LIMITS.length < 6) {
      return DEFAULT_JOINT_LIMITS;
    }

    const resolved = [];
    for (let servo = 0; servo < 6; servo += 1) {
      const fallback = DEFAULT_JOINT_LIMITS[servo] || [0, 180];
      const pair = NS.Generator.JOINT_LIMITS[servo];
      const min = Array.isArray(pair) ? Number(pair[0]) : NaN;
      const max = Array.isArray(pair) ? Number(pair[1]) : NaN;
      resolved.push([
        Number.isFinite(min) ? min : fallback[0],
        Number.isFinite(max) ? max : fallback[1]
      ]);
    }
    return resolved;
  }

  function registerBlocks() {
    if (registered) {
      return;
    }

    Blockly.Blocks.move_joint = {
      init() {
        this.appendDummyInput()
          .appendField("Move")
          .appendField(new Blockly.FieldDropdown(JOINT_OPTIONS), "JOINT")
          .appendField("to")
          .appendField(new Blockly.FieldNumber(90, 0, 180, 1), "ANGLE")
          .appendField("speed")
          .appendField(new Blockly.FieldNumber(50, 1, 100, 1), "SPEED");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
        this.setTooltip("Move one servo to an angle at a speed.");
      }
    };

    Blockly.Blocks.move_arm = {
      init() {
        const limits = getJointLimits();
        this.appendDummyInput()
          .appendField("Move arm")
          .appendField("Base")
          .appendField(new Blockly.FieldNumber(90, limits[0][0], limits[0][1], 1), "A0")
          .appendField("Shoulder")
          .appendField(new Blockly.FieldNumber(90, limits[1][0], limits[1][1], 1), "A1");

        this.appendDummyInput()
          .appendField("Elbow")
          .appendField(new Blockly.FieldNumber(90, limits[2][0], limits[2][1], 1), "A2")
          .appendField("Wrist Rot")
          .appendField(new Blockly.FieldNumber(90, limits[3][0], limits[3][1], 1), "A3")
          .appendField("Wrist Tilt")
          .appendField(new Blockly.FieldNumber(90, limits[4][0], limits[4][1], 1), "A4");

        this.appendDummyInput()
          .appendField("Gripper")
          .appendField(new Blockly.FieldNumber(90, limits[5][0], limits[5][1], 1), "A5")
          .appendField("speed")
          .appendField(new Blockly.FieldNumber(50, 1, 100, 1), "SPEED");

        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
        this.setTooltip("Move all six joints to a full pose.");
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
          .appendField("Gripper Open")
          .appendField("speed")
          .appendField(new Blockly.FieldNumber(DEFAULT_GRIPPER_SPEED, 1, 100, 1), "SPEED");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
        this.setTooltip("Open gripper at selected speed.");
      }
    };

    Blockly.Blocks.gripper_close = {
      init() {
        this.appendDummyInput()
          .appendField("Gripper Close")
          .appendField("speed")
          .appendField(new Blockly.FieldNumber(DEFAULT_GRIPPER_SPEED, 1, 100, 1), "SPEED");
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setStyle("movement_style");
        this.setTooltip("Close gripper at selected speed.");
      }
    };

    Blockly.Blocks.wait_seconds = {
      init() {
        this.appendDummyInput()
          .appendField("Wait")
          .appendField(new Blockly.FieldNumber(1, 0.1, 10, 0.1), "SECONDS")
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
          .appendField(
            new Blockly.FieldDropdown([
              ["true", "TRUE"],
              ["false", "FALSE"]
            ]),
            "COND"
          );
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
          .appendField(new Blockly.FieldDropdown(JOINT_OPTIONS), "JOINT")
          .appendField("from")
          .appendField(new Blockly.FieldNumber(90, 0, 180, 1), "FROM")
          .appendField("to")
          .appendField(new Blockly.FieldNumber(120, 0, 180, 1), "TO")
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

    registered = true;
  }

  function getPoseOptions() {
    const names = typeof NS.getPoseNames === "function" ? NS.getPoseNames() : [];
    if (!Array.isArray(names) || names.length === 0) {
      return [["No poses", "__none__"]];
    }
    return names.map((name) => [name, name]);
  }

  function toolboxXml() {
    return `
      <category name="Movement" categorystyle="movement_category">
        <block type="move_joint"></block>
        <block type="move_arm"></block>
        <block type="home_position"></block>
        <block type="gripper_open"></block>
        <block type="gripper_close"></block>
      </category>
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

  NS.Blocks = {
    registerBlocks,
    toolboxXml,
    createTheme,
    JOINT_OPTIONS,
    JOINT_LIMITS: DEFAULT_JOINT_LIMITS
  };
})();
