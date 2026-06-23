export const ARM_RIG_CONFIG = Object.freeze({
  // Printed-part meshes are generated into browser-safe quantized buffers by
  // tools/build-arm-preview-mesh-data.py.
  //
  // Rig geometry is derived from the original assembled CAD model
  // ("Robotic Arm 3D Model.STEP") via tools/step_assembly.py +
  // tools/derive_rig.py: joint pivots sit on the measured hinge-hole axes
  // (tools/measure_holes.py) and every mate was cross-checked against the
  // STEP assembly to ~5 micrometers. Home pose (all servos 90) = arm
  // straight up, matching firmware semantics.
  units: "mm",
  threeVersion: "0.184.0",
  firmware: {
    home: [90, 90, 90, 90, 90, 90],
    limits: [
      [20, 130],
      [15, 165],
      [0, 180],
      [0, 180],
      [0, 180],
      [25, 130]
    ],
    reversed: [false, false, true, false, false, false]
  },
  // Physical chain order: wrist ROTATE (servo 3) sits between Arm 02 and
  // Arm 03; wrist TILT (servo 4) carries the gripper base.
  joints: [
    { servo: 0, id: "baseYaw", label: "Base yaw", axis: "Y" },
    { servo: 1, id: "shoulderPitch", label: "Shoulder", axis: "Z" },
    { servo: 2, id: "elbowPitch", label: "Elbow", axis: "Z", reversed: true },
    { servo: 3, id: "wristRotate", label: "Wrist rot", axis: "Y" },
    { servo: 4, id: "wristTilt", label: "Wrist tilt", axis: "Z" },
    { servo: 5, id: "gripper", label: "Gripper", axis: "linkage" }
  ],
  dimensions: {
    baseHeight: 57,
    shoulderHingeAboveWaistSeat: 40.453,
    shoulderLink: 120.004,
    elbowToWristRotateHorn: 94.196,
    wristRotateToTiltHinge: 25.46,
    gripperBaseLength: 77,
    gripperFingerLength: 65.3
  },
  // Joint pivots in parent-group coordinates (from derive_rig.py).
  rig: {
    baseYaw: [0, 57, 0],
    shoulder: [13.742, 40.453, 1.2],
    elbow: [0.005, 120.004, 0],
    wristRotate: [5.055, 94.196, -13.7],
    wristTilt: [-5.0, 25.46, 13.1]
  },
  kinematicChain: [
    {
      id: "baseYaw",
      servo: 0,
      parent: "root",
      pivot: [0, 57, 0],
      axis: [0, 1, 0],
      visualSign: 1,
      offsetDeg: 0
    },
    {
      id: "shoulderPitch",
      servo: 1,
      parent: "baseYaw",
      pivot: [13.742, 40.453, 1.2],
      axis: [0, 0, 1],
      visualSign: -1,
      offsetDeg: 0
    },
    {
      id: "elbowPitch",
      servo: 2,
      parent: "shoulderPitch",
      pivot: [0.005, 120.004, 0],
      axis: [0, 0, 1],
      visualSign: 1,
      offsetDeg: 0
    },
    {
      id: "wristRotate",
      servo: 3,
      parent: "elbowPitch",
      pivot: [5.055, 94.196, -13.7],
      axis: [0, 1, 0],
      visualSign: 1,
      offsetDeg: 0
    },
    {
      id: "wristTilt",
      servo: 4,
      parent: "wristRotate",
      pivot: [-5.0, 25.46, 13.1],
      axis: [0, 0, 1],
      visualSign: 1,
      offsetDeg: 0
    }
  ],
  attachments: [
    { part: "base", parent: "staticBase" },
    { part: "waist", parent: "baseYaw" },
    { part: "arm01", parent: "shoulderPitch" },
    { part: "arm02", parent: "elbowPitch" },
    { part: "arm03", parent: "wristRotate" },
    { part: "gripperBase", parent: "gripperRoot" }
  ],
  // Gripper mechanism: two mirrored four-bar linkages in the gripper-base
  // plane, driven by servo 5 through gear2 (horn-mounted) meshing gear1.
  // Each side: crank = gear arm, coupler = the finger itself (its two holes
  // are 22 mm apart), rocker = a pair of grip-link bars sandwiching the
  // finger. All axles/holes from measured mesh geometry; baked mesh poses are
  // the STEP assembly pose (= tips-touching, closed).
  gripperLinkage: {
    servo: 5,
    parent: "wristTilt",
    rootGroup: "gripperRoot",
    // gripper-base placement under wristTilt (horn standoff -4.59 mm axial)
    rootRotation: [-90, 0, 90],
    rootPosition: [-0.044, -0.041, -4.59],
    baseAnchor: [11.66, 14, 14],
    lowerServoIsOpen: true,
    // Crank rotates 1:1 with the servo horn over the 105 deg firmware range;
    // runtime caps travel to the four-bar's solvable span.
    crankTravelDeg: 105,
    sides: {
      right: {
        crankGroup: "gearRight",
        linkGroup: "linkPairRight",
        couplerGroup: "fingerRight",
        crankAxle: [31.9, 52],
        linkAxle: [23, 72],
        crankLen: 30.753,
        crankZeroDeg: 54.64,
        linkLen: 31.0,
        couplerLen: 22.005,
        branchSign: 1,
        crankDir: -1
      },
      left: {
        crankGroup: "gearLeft",
        linkGroup: "linkPairLeft",
        couplerGroup: "fingerLeft",
        crankAxle: [5, 52],
        linkAxle: [13, 72],
        crankLen: 30.75,
        crankZeroDeg: 125.567,
        linkLen: 31.0,
        couplerLen: 22.0,
        branchSign: -1,
        crankDir: 1
      }
    },
    parts: [
      {
        key: "gear2",
        meshKey: "gear2",
        group: "gearRight",
        label: "Gear 2 (drive)",
        category: "Gears",
        material: "gear",
        anchorPoint: [34.49, 2, 14.54],
        rotation: [0, 117.871, 0],
        holePlaneY: 33.5
      },
      {
        key: "gear1",
        meshKey: "gear1",
        group: "gearLeft",
        label: "Gear 1 (idler)",
        category: "Gears",
        material: "gear",
        anchorPoint: [14.54, 2, 14.54],
        rotation: [0, -125.571, 0],
        holePlaneY: 33.5
      },
      {
        key: "gripLinkRightLower",
        meshKey: "gripLink1",
        group: "linkPairRight",
        label: "Grip link (right lower)",
        category: "Gripper",
        material: "gear",
        anchorPoint: [35, 2, 4],
        rotation: [0, 125.413, 0],
        holePlaneY: 21
      },
      {
        key: "gripLinkRightUpper",
        meshKey: "gripLink1",
        group: "linkPairRight",
        label: "Grip link (right upper)",
        category: "Gripper",
        material: "gear",
        anchorPoint: [35, 2, 4],
        rotation: [0, 125.413, 0],
        holePlaneY: 33.5
      },
      {
        key: "gripLinkLeftLower",
        meshKey: "gripLink1",
        group: "linkPairLeft",
        label: "Grip link (left lower)",
        category: "Gripper",
        material: "gear",
        anchorPoint: [35, 2, 4],
        rotation: [0, 55.145, 0],
        holePlaneY: 21
      },
      {
        key: "gripLinkLeftUpper",
        meshKey: "gripLink1",
        group: "linkPairLeft",
        label: "Grip link (left upper)",
        category: "Gripper",
        material: "gear",
        anchorPoint: [35, 2, 4],
        rotation: [180, -55.145, 0],
        holePlaneY: 33.5
      },
      {
        key: "fingerRight",
        meshKey: "gripperFinger",
        group: "fingerRight",
        label: "Finger (right)",
        category: "Gripper",
        material: "gripperFinger",
        anchorPoint: [4.25, 5, 60.32],
        rotation: [180, 23.397, -90],
        holePlaneY: 27.25
      },
      {
        key: "fingerLeft",
        meshKey: "gripperFinger",
        group: "fingerLeft",
        label: "Finger (left)",
        category: "Gripper",
        material: "gripperFinger",
        anchorPoint: [4.25, 5, 60.32],
        rotation: [180, -21.802, 90],
        holePlaneY: 27.25
      }
    ]
  },
  hardware: {},
  parts: {
    base: {
      label: "Base",
      meshKey: "base",
      category: "Base",
      material: "base",
      origin: "bottomCenter",
      anchorPoint: [60.625, 0, 60.625],
      outletPoint: [60.625, 56, 60.625],
      position: [0, 0, 0],
      rotation: [0, 0, 0]
    },
    waist: {
      label: "Waist",
      meshKey: "waist",
      category: "Base",
      material: "waist",
      origin: "bottomCenter",
      // Anchor on the turntable axis; rotated -90 so the shoulder bracket
      // hinge (waist local +X) lies along world +Z.
      anchorPoint: [48.5, 0, 48.5],
      outletPoint: [46.7, 40.453, 34.755],
      position: [0, 0, 0],
      rotation: [0, -90, 0]
    },
    arm01: {
      label: "Arm 01",
      meshKey: "arm01",
      category: "Links",
      material: "linkA",
      // Anchor at the measured lower hinge-hole center; the upper hole is
      // exactly 120.0 mm away along the link.
      anchorPoint: [28.455, 25.676, 3],
      outletPoint: [28.46, 145.68, 3],
      position: [0, 0, 0],
      rotation: [0, 0, 0]
    },
    arm02: {
      label: "Arm 02",
      meshKey: "arm02",
      category: "Links",
      material: "linkB",
      // Anchor at the elbow hinge center (from the STEP mate); Arm 02 is
      // Y-flipped in the assembly. Outlet = wrist-rotate servo axis point.
      anchorPoint: [19.04, 13.75, 0.18],
      outletPoint: [13.987, 105.35, 13.878],
      position: [0, 0, 0],
      rotation: [0, 180, 0]
    },
    arm03: {
      label: "Arm 03",
      meshKey: "arm03",
      category: "Links",
      material: "linkC",
      // Anchor at the wrist-rotate horn pattern center on its bottom face;
      // outlet = wrist-tilt hinge hole.
      anchorPoint: [11.5, 2.6, 14],
      outletPoint: [16.5, 28.06, 0.9],
      position: [0, 0, 0],
      rotation: [0, 180, 0]
    },
    gripperBase: {
      label: "Gripper base",
      meshKey: "gripperBase",
      category: "Gripper",
      material: "gripperBase",
      // Anchor at the tilt-horn pattern center on its side plate; placed at
      // identity under gripperRoot (which carries the tilt-frame transform).
      anchorPoint: [11.66, 14, 14],
      outletPoint: [18.45, 25.38, 72],
      position: [0, 0, 0],
      rotation: [0, 0, 0]
    }
  },
  materials: {
    base: { color: 0x4b5563, roughness: 0.72, metalness: 0.04 },
    waist: { color: 0x687385, roughness: 0.68, metalness: 0.06 },
    linkA: { color: 0x4f8cff, roughness: 0.58, metalness: 0.04 },
    linkB: { color: 0xf0a43a, roughness: 0.62, metalness: 0.04 },
    linkC: { color: 0x35b779, roughness: 0.58, metalness: 0.04 },
    gripperBase: { color: 0xb7c1cc, roughness: 0.64, metalness: 0.05 },
    gripperFinger: { color: 0xdf625c, roughness: 0.6, metalness: 0.04 },
    gear: { color: 0x9aa6b2, roughness: 0.68, metalness: 0.08 },
    servoBody: { color: 0x20262d, roughness: 0.7, metalness: 0.06 },
    servoHorn: { color: 0xd8dee6, roughness: 0.45, metalness: 0.18 },
    screwHead: { color: 0x16191d, roughness: 0.42, metalness: 0.28 },
    fallback: { color: 0xff6b6b, roughness: 0.5, metalness: 0 }
  },
  categories: ["Base", "Links", "Gripper", "Gears"]
});
