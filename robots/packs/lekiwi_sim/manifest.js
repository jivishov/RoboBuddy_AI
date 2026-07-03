(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const registry = NS.RobotRegistry;
  if (!registry) {
    throw new Error("Robot registry must load before lekiwi_sim manifest.");
  }

  registry.register({
    id: "lekiwi_sim",
    name: "LeKiwi mobile robot",
    shortName: "LeKiwi mobile robot",
    formFactor: "mobile_manipulator",
    maturity: "tier1_sim_only",
    defaultMode: "simulate",
    supportedModes: ["simulate"],
    hardware: {
      adapter: null,
      requiresLocalBridge: false,
      requiresCalibration: false
    },
    capabilities: [
      "home",
      "stop",
      "drive_2d",
      "holonomic_drive",
      "joint_control",
      "multi_joint_pose",
      "gripper",
      "python",
      "blockly"
    ],
    mobileBase: {
      type: "holonomic_3_wheel",
      pose: { x: 0, y: 0, theta: 0 },
      maxLinearSpeed: 1.0,
      maxAngularSpeed: 90
    },
    joints: [
      { id: "shoulder_pan", label: "Arm Pan", type: "revolute", unit: "deg", min: -90, max: 90, home: 0, speedMin: 1, speedMax: 100 },
      { id: "shoulder_lift", label: "Shoulder Lift", type: "revolute", unit: "deg", min: -90, max: 90, home: 0, speedMin: 1, speedMax: 100 },
      { id: "elbow_flex", label: "Elbow Flex", type: "revolute", unit: "deg", min: -120, max: 120, home: 0, speedMin: 1, speedMax: 100 },
      { id: "wrist_flex", label: "Wrist Flex", type: "revolute", unit: "deg", min: -90, max: 90, home: 0, speedMin: 1, speedMax: 100 },
      { id: "wrist_roll", label: "Wrist Roll", type: "revolute", unit: "deg", min: -90, max: 90, home: 0, speedMin: 1, speedMax: 100 },
      { id: "gripper", label: "Gripper", type: "gripper", unit: "percent", min: 0, max: 100, home: 50, open: 20, close: 85, speedMin: 1, speedMax: 100 }
    ],
    ui: {
      controlLayout: "mobile_manipulator",
      previewType: "mobile_base_grid",
      icon: "mobile-robot"
    },
    modelSource: {
      format: "urdf",
      repository: "https://github.com/SIGRobotics-UIUC/LeKiwi",
      path: "URDF/LeKiwi.urdf",
      url: "https://raw.githubusercontent.com/SIGRobotics-UIUC/LeKiwi/main/URDF/LeKiwi.urdf",
      notes: "The in-browser simulator loads an official URDF/STL-derived LeKiwi assembly."
    },
    chooser: {
      level: "Intermediate",
      modeLabel: "Sim only",
      description: "LeKiwi mobile robot"
    }
  });
})();
