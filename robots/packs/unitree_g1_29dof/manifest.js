(() => {
  const NS = (window.RoboAdmin = window.RoboAdmin || {});
  const registry = NS.RobotRegistry;
  if (!registry) {
    throw new Error("Robot registry must load before unitree_g1_29dof manifest.");
  }

  const joint = (id, label, subsystem, min, max, sourceRangeRad) => ({
    id,
    label,
    subsystem,
    type: "revolute",
    unit: "deg",
    min,
    max,
    home: 0,
    step: 0.5,
    speedMin: 1,
    speedMax: 100,
    sourceUnit: "rad",
    sourceRangeRad
  });

  const zeroPose = {
    left_hip_pitch_joint: 0,
    left_hip_roll_joint: 0,
    left_hip_yaw_joint: 0,
    left_knee_joint: 0,
    left_ankle_pitch_joint: 0,
    left_ankle_roll_joint: 0,
    right_hip_pitch_joint: 0,
    right_hip_roll_joint: 0,
    right_hip_yaw_joint: 0,
    right_knee_joint: 0,
    right_ankle_pitch_joint: 0,
    right_ankle_roll_joint: 0,
    waist_yaw_joint: 0,
    waist_roll_joint: 0,
    waist_pitch_joint: 0,
    left_shoulder_pitch_joint: 0,
    left_shoulder_roll_joint: 0,
    left_shoulder_yaw_joint: 0,
    left_elbow_joint: 0,
    left_wrist_roll_joint: 0,
    left_wrist_pitch_joint: 0,
    left_wrist_yaw_joint: 0,
    right_shoulder_pitch_joint: 0,
    right_shoulder_roll_joint: 0,
    right_shoulder_yaw_joint: 0,
    right_elbow_joint: 0,
    right_wrist_roll_joint: 0,
    right_wrist_pitch_joint: 0,
    right_wrist_yaw_joint: 0
  };

  registry.register({
    id: "unitree_g1_29dof",
    name: "Unitree G1 29-DoF",
    shortName: "Unitree G1",
    formFactor: "humanoid",
    maturity: "tier1_kinematic_sim",
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
      "joint_control",
      "multi_joint_pose",
      "smooth_joint_motion",
      "posture_presets",
      "humanoid_walk",
      "humanoid_turn",
      "fixed_hand_interaction",
      "scripted_demo",
      "python",
      "blockly"
    ],
    joints: [
      joint("left_hip_pitch_joint", "Left Hip Pitch", "left_leg", -144.9984, 165.0004, [-2.5307, 2.8798]),
      joint("left_hip_roll_joint", "Left Hip Roll", "left_leg", -30.0001, 170.0023, [-0.5236, 2.9671]),
      joint("left_hip_yaw_joint", "Left Hip Yaw", "left_leg", -157.9988, 157.9988, [-2.7576, 2.7576]),
      joint("left_knee_joint", "Left Knee", "left_leg", -5, 165.0004, [-0.087267, 2.8798]),
      joint("left_ankle_pitch_joint", "Left Ankle Pitch", "left_leg", -50.0003, 30.0001, [-0.87267, 0.5236]),
      joint("left_ankle_roll_joint", "Left Ankle Roll", "left_leg", -15, 15, [-0.2618, 0.2618]),
      joint("right_hip_pitch_joint", "Right Hip Pitch", "right_leg", -144.9984, 165.0004, [-2.5307, 2.8798]),
      joint("right_hip_roll_joint", "Right Hip Roll", "right_leg", -170.0023, 30.0001, [-2.9671, 0.5236]),
      joint("right_hip_yaw_joint", "Right Hip Yaw", "right_leg", -157.9988, 157.9988, [-2.7576, 2.7576]),
      joint("right_knee_joint", "Right Knee", "right_leg", -5, 165.0004, [-0.087267, 2.8798]),
      joint("right_ankle_pitch_joint", "Right Ankle Pitch", "right_leg", -50.0003, 30.0001, [-0.87267, 0.5236]),
      joint("right_ankle_roll_joint", "Right Ankle Roll", "right_leg", -15, 15, [-0.2618, 0.2618]),
      joint("waist_yaw_joint", "Waist Yaw", "waist", -150.0004, 150.0004, [-2.618, 2.618]),
      joint("waist_roll_joint", "Waist Roll", "waist", -29.7938, 29.7938, [-0.52, 0.52]),
      joint("waist_pitch_joint", "Waist Pitch", "waist", -29.7938, 29.7938, [-0.52, 0.52]),
      joint("left_shoulder_pitch_joint", "Left Shoulder Pitch", "left_arm", -176.9981, 153.0026, [-3.0892, 2.6704]),
      joint("left_shoulder_roll_joint", "Left Shoulder Roll", "left_arm", -90.9972, 129.0014, [-1.5882, 2.2515]),
      joint("left_shoulder_yaw_joint", "Left Shoulder Yaw", "left_arm", -150.0004, 150.0004, [-2.618, 2.618]),
      joint("left_elbow_joint", "Left Elbow", "left_arm", -60.0001, 120.0003, [-1.0472, 2.0944]),
      joint("left_wrist_roll_joint", "Left Wrist Roll", "left_arm", -112.9999, 112.9999, [-1.972222054, 1.972222054]),
      joint("left_wrist_pitch_joint", "Left Wrist Pitch", "left_arm", -92.5, 92.5, [-1.614429558, 1.614429558]),
      joint("left_wrist_yaw_joint", "Left Wrist Yaw", "left_arm", -92.5, 92.5, [-1.614429558, 1.614429558]),
      joint("right_shoulder_pitch_joint", "Right Shoulder Pitch", "right_arm", -176.9981, 153.0026, [-3.0892, 2.6704]),
      joint("right_shoulder_roll_joint", "Right Shoulder Roll", "right_arm", -129.0014, 90.9972, [-2.2515, 1.5882]),
      joint("right_shoulder_yaw_joint", "Right Shoulder Yaw", "right_arm", -150.0004, 150.0004, [-2.618, 2.618]),
      joint("right_elbow_joint", "Right Elbow", "right_arm", -60.0001, 120.0003, [-1.0472, 2.0944]),
      joint("right_wrist_roll_joint", "Right Wrist Roll", "right_arm", -112.9999, 112.9999, [-1.972222054, 1.972222054]),
      joint("right_wrist_pitch_joint", "Right Wrist Pitch", "right_arm", -92.5, 92.5, [-1.614429558, 1.614429558]),
      joint("right_wrist_yaw_joint", "Right Wrist Yaw", "right_arm", -92.5, 92.5, [-1.614429558, 1.614429558])
    ],
    initialPose: {
      id: "neutral",
      label: "Neutral",
      joints: zeroPose
    },
    postures: {
      neutral: { label: "Neutral", joints: zeroPose },
      inspection: {
        label: "Inspection",
        joints: {
          ...zeroPose,
          left_shoulder_roll_joint: 45,
          left_elbow_joint: 35,
          left_wrist_pitch_joint: 15,
          right_shoulder_roll_joint: -45,
          right_elbow_joint: 35,
          right_wrist_pitch_joint: 15
        }
      },
      work_reach: {
        label: "Work Reach",
        joints: {
          ...zeroPose,
          waist_pitch_joint: 8,
          left_shoulder_pitch_joint: -55,
          left_shoulder_roll_joint: 15,
          left_elbow_joint: 55,
          left_wrist_pitch_joint: -10,
          right_shoulder_pitch_joint: -55,
          right_shoulder_roll_joint: -15,
          right_elbow_joint: 55,
          right_wrist_pitch_joint: -10
        }
      },
      wide_stance: {
        label: "Wide Stance",
        joints: {
          ...zeroPose,
          left_hip_roll_joint: 12,
          left_ankle_roll_joint: -7,
          right_hip_roll_joint: -12,
          right_ankle_roll_joint: 7,
          left_shoulder_roll_joint: 25,
          right_shoulder_roll_joint: -25
        }
      },
      crouch: {
        label: "Crouch",
        joints: {
          ...zeroPose,
          left_hip_pitch_joint: -28,
          left_knee_joint: 52,
          left_ankle_pitch_joint: -24,
          right_hip_pitch_joint: -28,
          right_knee_joint: 52,
          right_ankle_pitch_joint: -24,
          waist_pitch_joint: 10,
          left_shoulder_pitch_joint: -18,
          left_elbow_joint: 28,
          right_shoulder_pitch_joint: -18,
          right_elbow_joint: 28
        }
      }
    },
    humanoid: {
      kinematicOnly: true,
      stepLengthMinM: 0.02,
      stepLengthMaxM: 0.12,
      maxSteps: 20,
      maxTurnDeg: 180,
      pickupRadiusM: 0.34,
      hands: ["left_hand", "right_hand"],
      demoId: "walk_grab_return"
    },
    ui: {
      controlLayout: "humanoid_grouped",
      previewType: "humanoid_rig",
      icon: "bot",
      jointGroups: [
        { id: "left_leg", label: "Left leg" },
        { id: "right_leg", label: "Right leg" },
        { id: "waist", label: "Waist" },
        { id: "left_arm", label: "Left arm and wrist" },
        { id: "right_arm", label: "Right arm and wrist" }
      ]
    },
    modelSource: {
      format: "urdf-baked-stl-meshes",
      repository: "https://github.com/unitreerobotics/unitree_ros",
      revision: "dd4fa6866e523ad61324f658d63736e4eda3a6e4",
      path: "robots/g1_description/g1_29dof.urdf",
      url: "https://raw.githubusercontent.com/unitreerobotics/unitree_ros/dd4fa6866e523ad61324f658d63736e4eda3a6e4/robots/g1_description/g1_29dof.urdf",
      license: "BSD-3-Clause",
      notes: "The browser loads a local baked copy of all 36 official visual meshes."
    },
    chooser: {
      level: "Intermediate/Advanced",
      modeLabel: "Kinematic sim",
      description: "29-DoF humanoid"
    },
    limitations: [
      "Stepping and turning are scripted kinematic visualizations, not dynamically balanced locomotion.",
      "The selected official model has fixed rubber hands and no articulated finger joints.",
      "No physical Unitree hardware control is included."
    ]
  });
})();

\n