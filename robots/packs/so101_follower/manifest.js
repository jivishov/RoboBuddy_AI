(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const registry = NS.RobotRegistry;
  if (!registry) {
    throw new Error("Robot registry must load before so101_follower manifest.");
  }

  registry.register({
    id: "so101_follower",
    name: "SO-101 Follower",
    shortName: "SO-101 Follower",
    formFactor: "arm",
    maturity: "tier1_sim_bridge",
    defaultMode: "simulate",
    supportedModes: ["simulate", "local_bridge"],
    hardware: {
      adapter: "lerobot_so101",
      requiresLocalBridge: true,
      requiresCalibration: true
    },
    capabilities: [
      "home",
      "stop",
      "joint_control",
      "virtual_leader",
      "multi_joint_pose",
      "gripper",
      "teach_replay",
      "python",
      "blockly"
    ],
    virtualLeader: {
      hardwareDefault: "disabled",
      staleAfterMs: 250,
      heartbeatAfterMs: 100,
      maxFrameRateHz: 30,
      observationRateHz: 5,
      deadZone: 0.12,
      pairs: {
        base: { label: "Base", horizontal: "shoulder_pan", vertical: "shoulder_lift" },
        bend: { label: "Bend", horizontal: "elbow_flex", vertical: "wrist_flex" },
        tool: { label: "Tool", horizontal: "wrist_roll", vertical: "gripper" }
      },
      speedLevels: {
        fine: { label: "Fine", revolute: 6, gripper: 10 },
        normal: { label: "Normal", revolute: 24, gripper: 35 },
        coarse: { label: "Coarse", revolute: 48, gripper: 70 }
      },
      gamepad: {
        profileId: "xbox_standard_v1",
        mapping: "standard",
        minimumAxes: 2,
        minimumButtons: 16,
        stickNeutral: 0.12,
        stickEngage: 0.18,
        deadmanEngage: 0.65,
        deadmanRelease: 0.35,
        neutralHoldMs: 250,
        pollGapMs: 120,
        controls: {
          move: { horizontalAxis: 0, verticalAxis: 1, invertVertical: true },
          deadman: { button: 7 },
          fineOverride: { button: 4 },
          cancel: { button: 2 },
          stop: { button: 1 },
          previousPair: { button: 14 },
          nextPair: { button: 15 }
        }
      },
      operatingLimits: {
        wrist_roll: { min: -43.2, max: 52.2 }
      }
    },
    joints: [
      { id: "shoulder_pan", label: "Shoulder Pan", type: "revolute", unit: "deg", min: -90, max: 90, home: 0, speedMin: 1, speedMax: 100 },
      { id: "shoulder_lift", label: "Shoulder Lift", type: "revolute", unit: "deg", min: -90, max: 90, home: -90, speedMin: 1, speedMax: 100 },
      { id: "elbow_flex", label: "Elbow Flex", type: "revolute", unit: "deg", min: -120, max: 120, home: 85, speedMin: 1, speedMax: 100 },
      { id: "wrist_flex", label: "Wrist Flex", type: "revolute", unit: "deg", min: -90, max: 90, home: 72, speedMin: 1, speedMax: 100 },
      { id: "wrist_roll", label: "Wrist Roll", type: "revolute", unit: "deg", min: -180, max: 180, home: 88, speedMin: 1, speedMax: 100 },
      { id: "gripper", label: "Gripper", type: "gripper", unit: "percent", min: 0, max: 100, home: 85, open: 20, close: 85, speedMin: 1, speedMax: 100 }
    ],
    initialPose: {
      id: "compact_closed",
      label: "Compact Closed",
      joints: {
        shoulder_pan: 0,
        shoulder_lift: -90,
        elbow_flex: 85,
        wrist_flex: 72,
        wrist_roll: 88,
        gripper: 85
      }
    },
    ui: {
      controlLayout: "arm_sliders",
      previewType: "kinematic_arm",
      icon: "robot-arm"
    },
    modelSource: {
      format: "urdf-baked-stl-meshes",
      repository: "https://github.com/TheRobotStudio/SO-ARM100",
      path: "Simulation/SO101/so101_new_calib.urdf",
      url: "https://raw.githubusercontent.com/TheRobotStudio/SO-ARM100/main/Simulation/SO101/so101_new_calib.urdf",
      notes: "The in-browser simulator loads local baked mesh data derived from the official URDF and STL assets."
    },
    chooser: {
      level: "Beginner/Intermediate",
      modeLabel: "Sim Only",
      description: "SO-101 Follower"
    },
    limitations: [
      "Frontend limits are conservative educational placeholders. The bridge must prefer calibrated runtime limits."
    ]
  });
})();
