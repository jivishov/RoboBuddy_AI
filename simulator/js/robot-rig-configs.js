export const ROBOT_RIG_PREVIEW_CONFIGS = Object.freeze({
  so101_follower: {
    title: "LeRobot SO-101 F",
    units: "mm",
    source: {
      format: "urdf-baked-meshes",
      url: "https://raw.githubusercontent.com/TheRobotStudio/SO-ARM100/main/Simulation/SO101/so101_new_calib.urdf",
      notes: "Official URDF joints and decimated STL meshes baked by tools/build-robot-rig-mesh-data.py. STL vertices and transforms are both in the Three.js Y-up frame."
    },
    meshData: {
      module: "./robot-mesh-data-so101.js",
      version: "20260702-so101-yup-mesh"
    },
    camera: {
      position: [430, 320, 520],
      target: [150, 110, 0]
    },
    materials: {
      printed: { color: 0xf4c430, roughness: 0.64, metalness: 0.03 },
      servo: { color: 0x20242c, roughness: 0.72, metalness: 0.06 },
      link: { color: 0x2f7ed8, roughness: 0.58, metalness: 0.04 },
      wrist: { color: 0x16a085, roughness: 0.6, metalness: 0.04 },
      gripper: { color: 0xdf625c, roughness: 0.62, metalness: 0.03 },
      joint: { color: 0xe8edf5, roughness: 0.42, metalness: 0.16 },
      accent: { color: 0x7c8ea3, roughness: 0.68, metalness: 0.04 }
    },
    chain: [
      {
        id: "shoulderPan",
        jointId: "shoulder_pan",
        label: "Shoulder Pan",
        parent: "root",
        pivot: [0, 62, 0],
        axis: [0, 1, 0],
        sign: 1,
        source: {
          joint: "shoulder_pan",
          origin: "0.0388353 -8.97657e-09 0.0624",
          axis: "0 0 1"
        }
      },
      {
        id: "shoulderLift",
        jointId: "shoulder_lift",
        label: "Shoulder Lift",
        parent: "shoulderPan",
        pivot: [0, 24, 0],
        axis: [0, 0, 1],
        sign: -1,
        source: {
          joint: "shoulder_lift",
          origin: "-0.0303992 -0.0182778 -0.0542",
          axis: "0 0 1"
        }
      },
      {
        id: "elbowFlex",
        jointId: "elbow_flex",
        label: "Elbow Flex",
        parent: "shoulderLift",
        pivot: [-113, 0, 0],
        axis: [0, 0, 1],
        sign: 1,
        source: {
          joint: "elbow_flex",
          origin: "-0.11257 -0.028 1.73763e-16",
          axis: "0 0 1"
        }
      },
      {
        id: "wristFlex",
        jointId: "wrist_flex",
        label: "Wrist Flex",
        parent: "elbowFlex",
        pivot: [-135, 0, 0],
        axis: [0, 0, 1],
        sign: 1,
        source: {
          joint: "wrist_flex",
          origin: "-0.1349 0.0052 3.62355e-17",
          axis: "0 0 1"
        }
      },
      {
        id: "wristRoll",
        jointId: "wrist_roll",
        label: "Wrist Roll",
        parent: "wristFlex",
        pivot: [-61, 0, 0],
        axis: [1, 0, 0],
        sign: 1,
        source: {
          joint: "wrist_roll",
          origin: "5.55112e-17 -0.0611 0.0181",
          axis: "0 0 1"
        }
      },
      {
        id: "gripperRoot",
        parent: "wristRoll",
        pivot: [-42, 0, 0],
        axis: [1, 0, 0],
        sign: 0,
        source: {
          joint: "gripper",
          origin: "0.0202 0.0188 -0.0234",
          axis: "0 0 1"
        }
      }
    ]
  },

  lekiwi_sim: {
    title: "LeKiwi mobile robot",
    units: "mm",
    source: {
      format: "urdf-baked-meshes",
      url: "https://raw.githubusercontent.com/SIGRobotics-UIUC/LeKiwi/main/URDF/LeKiwi.urdf",
      notes: "Official URDF joints and decimated STL meshes baked by tools/build-robot-rig-mesh-data.py. STL vertices and transforms are both in the Three.js Y-up frame."
    },
    meshData: {
      module: "./robot-mesh-data-lekiwi.js",
      version: "20260703-lekiwi-gripper-calibration"
    },
    mobileBase: {
      positionScale: 1000,
      thetaSign: -1,
      followBase: true,
      wheelRadiusMm: 48,
      wheels: [
        {
          id: "front",
          group: "st3215_servo_motor_v1_2_revolute_60",
          axis: [0, -1, 0],
          spinSign: 1
        },
        {
          id: "right",
          group: "st3215_servo_motor_v1_1_revolute_62",
          axis: [0.866025, 0.5, 0],
          spinSign: 1
        },
        {
          id: "left",
          group: "st3215_servo_motor_v1_revolute_64",
          axis: [-0.866025, 0.5, 0],
          spinSign: 1
        }
      ]
    },
    floor: {
      grid: 2400,
      gridDivisions: 48,
      radius: 1250
    },
    camera: {
      position: [-620, 350, 240],
      target: [-60, 125, 45]
    },
    materials: {
      plate: { color: 0x1f8a8a, roughness: 0.66, metalness: 0.04 },
      wheel: { color: 0x20242c, roughness: 0.74, metalness: 0.08 },
      tire: { color: 0x555f6d, roughness: 0.7, metalness: 0.04 },
      mount: { color: 0xd7dde7, roughness: 0.5, metalness: 0.16 },
      servo: { color: 0x242832, roughness: 0.72, metalness: 0.06 },
      link: { color: 0xf0a43a, roughness: 0.6, metalness: 0.04 },
      wrist: { color: 0x5271ff, roughness: 0.58, metalness: 0.04 },
      gripper: { color: 0xdf625c, roughness: 0.62, metalness: 0.03 },
      joint: { color: 0xf1f5f9, roughness: 0.42, metalness: 0.14 }
    },
    chain: [
      {
        id: "shoulderPan",
        jointId: "shoulder_pan",
        label: "Arm Pan",
        parent: "root",
        pivot: [35, 76, 76],
        axis: [0, 1, 0],
        sign: 1,
        source: {
          joint: "STS3215_03a-v1_Revolute-45",
          origin: "-0.01025 0.0346 -0.0328",
          axis: "0 0 1"
        }
      },
      {
        id: "shoulderLift",
        jointId: "shoulder_lift",
        label: "Shoulder Lift",
        parent: "shoulderPan",
        pivot: [0, 24, 0],
        axis: [0, 0, 1],
        sign: -1,
        source: {
          joint: "STS3215_03a-v1-1_Revolute-49",
          origin: "0.0346 0.01025 -0.0328",
          axis: "1 0 0"
        }
      },
      {
        id: "elbowFlex",
        jointId: "elbow_flex",
        label: "Elbow Flex",
        parent: "shoulderLift",
        pivot: [-104, 0, 0],
        axis: [0, 0, 1],
        sign: 1,
        source: {
          joint: "STS3215_03a-v1-2_Revolute-51",
          origin: "0.0346 -0.01306971 0.03178184",
          axis: "1 0 0"
        }
      },
      {
        id: "wristFlex",
        jointId: "wrist_flex",
        label: "Wrist Flex",
        parent: "elbowFlex",
        pivot: [-102, 0, 0],
        axis: [0, 0, 1],
        sign: 1,
        source: {
          joint: "STS3215_03a-v1-3_Revolute-53",
          origin: "0.0346 -0.03408158 0.00439862",
          axis: "1 0 0"
        }
      },
      {
        id: "wristRoll",
        jointId: "wrist_roll",
        label: "Wrist Roll",
        parent: "wristFlex",
        pivot: [-67, 0, 0],
        axis: [1, 0, 0],
        sign: 1,
        source: {
          joint: "STS3215_03a_Wrist_Roll-v1_Revolute-55",
          origin: "0.0137 -0.01906372 -0.0553747",
          axis: "0 -0.906308 -0.422618"
        }
      },
      {
        id: "gripperRoot",
        parent: "wristRoll",
        pivot: [-42, 0, 0],
        axis: [1, 0, 0],
        sign: 0,
        source: {
          joint: "STS3215_03a-v1-4_Revolute-57",
          origin: "-0.0328 -0.02391225 0.02702641",
          axis: "0 -0.906308 -0.422618"
        }
      }
    ]
  }
});
