(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const registry = NS.RobotRegistry;
  if (!registry) {
    throw new Error("Robot registry must load before arduino_arm manifest.");
  }

  registry.register({
    id: "arduino_arm",
    name: "Arduino Arm",
    shortName: "Arduino Arm",
    formFactor: "arm",
    maturity: "tier1_stable",
    defaultMode: "simulate",
    supportedModes: ["simulate", "hardware"],
    hardware: {
      adapter: "arduino_serial",
      requiresLocalBridge: false,
      requiresCalibration: false
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
      { id: "base", label: "Base", type: "revolute", unit: "deg", min: 20, max: 130, home: 90, speedMin: 1, speedMax: 100, servoIndex: 0 },
      { id: "shoulder", label: "Shoulder", type: "revolute", unit: "deg", min: 15, max: 165, home: 90, speedMin: 1, speedMax: 100, servoIndex: 1 },
      { id: "elbow", label: "Elbow", type: "revolute", unit: "deg", min: 0, max: 180, home: 90, speedMin: 1, speedMax: 100, servoIndex: 2 },
      { id: "wrist_rot", label: "Wrist Rot", type: "revolute", unit: "deg", min: 0, max: 180, home: 90, speedMin: 1, speedMax: 100, servoIndex: 3 },
      { id: "wrist_tilt", label: "Wrist Tilt", type: "revolute", unit: "deg", min: 0, max: 180, home: 90, speedMin: 1, speedMax: 100, servoIndex: 4 },
      { id: "gripper", label: "Gripper", type: "gripper", unit: "deg", min: 25, max: 130, home: 90, open: 50, close: 120, speedMin: 1, speedMax: 100, servoIndex: 5 }
    ],
    ui: {
      controlLayout: "arm_sliders",
      previewType: "existing_arm_preview",
      icon: "robot-arm"
    },
    chooser: {
      level: "Beginner",
      modeLabel: "Sim + Hardware",
      description: "Six-servo Arduino arm"
    }
  });
})();
