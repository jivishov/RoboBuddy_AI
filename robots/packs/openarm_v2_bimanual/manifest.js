(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const registry = NS.RobotRegistry;
  if (!registry) {
    throw new Error("Robot registry must load before openarm_v2_bimanual manifest.");
  }

  const joint = (id, label, min, max, home, type = "revolute", extra = {}) => ({
    id,
    label,
    type,
    unit: "deg",
    min,
    max,
    home,
    speedMin: 1,
    speedMax: 100,
    ...extra
  });

  registry.register({
    id: "openarm_v2_bimanual",
    name: "OpenArm v1 Bimanual · Simulator 550 mm Stand/Turntable",
    shortName: "OpenArm v1 Bimanual (simulator stand)",
    formFactor: "bimanual_manipulator",
    maturity: "tier1_sim_only",
    defaultMode: "simulate",
    supportedModes: ["simulate"],
    hardware: {
      adapter: null,
      requiresLocalBridge: false,
      requiresCalibration: true
    },
    capabilities: [
      "home",
      "stop",
      "joint_control",
      "multi_joint_pose",
      "gripper",
      "bimanual_control",
      "rotational_base",
      "teach_replay",
      "python",
      "blockly"
    ],
    joints: [
      joint("base_yaw", "Rotational Base", -180, 180, 0),
      joint("left_j1", "Left J1 · Shoulder Pan", -200, 80, -5),
      joint("left_j2", "Left J2 · Shoulder Lift", -190, 10, -40),
      joint("left_j3", "Left J3 · Shoulder Rotation", -90, 90, 0),
      joint("left_j4", "Left J4 · Elbow Flex", 0, 140, 120),
      joint("left_j5", "Left J5 · Wrist Roll", -90, 90, 0),
      joint("left_j6", "Left J6 · Wrist Pitch", -45, 45, -5),
      joint("left_j7", "Left J7 · Wrist Rotation", -90, 90, 0),
      joint("left_gripper", "Left Gripper", 0, 45, 45, "gripper", { side: "left", open: 45, close: 0 }),
      joint("right_j1", "Right J1 · Shoulder Pan", -80, 200, 5),
      joint("right_j2", "Right J2 · Shoulder Lift", -10, 190, 40),
      joint("right_j3", "Right J3 · Shoulder Rotation", -90, 90, 0),
      joint("right_j4", "Right J4 · Elbow Flex", 0, 140, 120),
      joint("right_j5", "Right J5 · Wrist Roll", -90, 90, 0),
      joint("right_j6", "Right J6 · Wrist Pitch", -45, 45, 5),
      joint("right_j7", "Right J7 · Wrist Rotation", -90, 90, 0),
      joint("right_gripper", "Right Gripper", 0, 45, 45, "gripper", { side: "right", open: 45, close: 0 })
    ],
    presets: {
      ready: {
        base_yaw: 0,
        left_j1: -5, left_j2: -40, left_j3: 0, left_j4: 120, left_j5: 0, left_j6: -5, left_j7: 0, left_gripper: 45,
        right_j1: 5, right_j2: 40, right_j3: 0, right_j4: 120, right_j5: 0, right_j6: 5, right_j7: 0, right_gripper: 45
      },
      surface_reach: {
        base_yaw: 0,
        left_j1: 20, left_j2: -7, left_j3: 0, left_j4: 0, left_j5: 0, left_j6: 1, left_j7: 0, left_gripper: 12,
        right_j1: -20, right_j2: 7, right_j3: 0, right_j4: 0, right_j5: 0, right_j6: 1, right_j7: 0, right_gripper: 12
      }
    },
    geometry: {
      originalShoulderMountHeightMm: 698,
      shoulderMountHeightMm: 550,
      standReductionMm: 148,
      baseYawRangeDeg: 360,
      arms: 2,
      armDofEach: 7,
      grippers: 2
    },
    ui: {
      controlLayout: "bimanual_arm_sliders",
      previewType: "kinematic_arm",
      icon: "bot"
    },
    modelSource: {
      format: "official-stl-baked-local-meshes",
      repository: "https://github.com/enactic/openarm_description",
      revision: "6c7b720f1ba48e8bafa3a3dc752c45f397b42221",
      localModule: "simulator/js/robot-mesh-data-openarm-v2.js",
      notes: "All official meshes are baked locally. The 550 mm stand, turntable, transforms, and integration code are RoboBuddy-side modifications. No task objects are included."
    },
    chooser: {
      level: "Advanced",
      modeLabel: "Simulation only",
      description: "Physical OpenArm v1 geometry on a separately configured simulator-only 550 mm stand/turntable"
    },
    limitations: [
      "No physical-hardware adapter, motor mapping, calibration profile, collision planner, or torque limits are included.",
      "The 550 mm stand and turntable are simulator-specific morphology and are not part of physical OpenArm v1."
    ]
  });
})();
