(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const registry = NS.RobotRegistry;
  if (!registry) {
    throw new Error("Robot registry must load before so101_follower manifest.");
  }

  registry.register({
    id: "so101_follower",
    name: "LeRobot SO-101 F",
    shortName: "LeRobot SO-101 F",
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
      "multi_joint_pose",
      "gripper",
      "teach_replay",
      "python",
      "blockly"
    ],
    joints: [
      { id: "shoulder_pan", label: "Shoulder Pan", type: "revolute", unit: "deg", min: -90, max: 90, home: 0, speedMin: 1, speedMax: 100 },
      { id: "shoulder_lift", label: "Shoulder Lift", type: "revolute", unit: "deg", min: -90, max: 90, home: 0, speedMin: 1, speedMax: 100 },
      { id: "elbow_flex", label: "Elbow Flex", type: "revolute", unit: "deg", min: -120, max: 120, home: 0, speedMin: 1, speedMax: 100 },
      { id: "wrist_flex", label: "Wrist Flex", type: "revolute", unit: "deg", min: -90, max: 90, home: 0, speedMin: 1, speedMax: 100 },
      { id: "wrist_roll", label: "Wrist Roll", type: "revolute", unit: "deg", min: -180, max: 180, home: 0, speedMin: 1, speedMax: 100 },
      { id: "gripper", label: "Gripper", type: "gripper", unit: "percent", min: 0, max: 100, home: 50, open: 20, close: 85, speedMin: 1, speedMax: 100 }
    ],
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
      description: "LeRobot SO-101 F"
    },
    limitations: [
      "Frontend limits are conservative educational placeholders. The bridge must prefer calibrated runtime limits."
    ]
  });
})();
