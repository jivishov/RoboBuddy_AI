import { ROBOT_RIG_MESH_DATA as SO101_MESH_DATA } from "../../simulator/js/robot-mesh-data-so101.js";

const LEROBOT_REVISION = "7e241bd630a3719a56157a497ce5d08f244784f1";
const URDF_REVISION = "7629d2ad9853d10fb903093a33ef6114099d97e5";
const BODY_JOINT_ORDER = Object.freeze([
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
  "wrist_roll"
]);
const JOINT_ORDER = Object.freeze([...BODY_JOINT_ORDER, "gripper"]);
const SIMULATION_REST = Object.freeze({
  shoulder_pan: 0,
  shoulder_lift: -90,
  elbow_flex: 85,
  wrist_flex: 72,
  wrist_roll: 88,
  gripper: 20
});

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

const meshJointById = new Map((SO101_MESH_DATA.chain || []).map((item) => [item.sourceJoint || item.jointId, item]));
const fields = JOINT_ORDER.map((jointId, index) => {
  const meshJoint = meshJointById.get(jointId);
  if (!meshJoint?.limitsDeg) throw new Error(`SO-101 baked mesh is missing ${jointId} limits.`);
  const isGripper = jointId === "gripper";
  return {
    index,
    motorId: index + 1,
    jointId,
    actionKey: `${jointId}.pos`,
    observationKey: `${jointId}.pos`,
    unit: isGripper ? "normalized_0_100" : "deg",
    min: isGripper ? 0 : Number(meshJoint.limitsDeg[0]),
    max: isGripper ? 100 : Number(meshJoint.limitsDeg[1]),
    simulationRest: SIMULATION_REST[jointId],
    rendererNode: meshJoint.id,
    rendererAxis: [...(meshJoint.axis || [0, 1, 0])],
    rendererDirection: Number(meshJoint.sign ?? 1),
    rangeBasis: isGripper
      ? "LeRobot calibrated RANGE_0_100 command/observation normalization"
      : "Official SO-101 URDF mechanical joint limit used as the simulation envelope"
  };
});

export const SO101_COMMAND_MODEL = freeze({
  schema: "robobuddy.so101-command-model.v2",
  robotId: "so101_follower",
  actionMethod: "send_action",
  observationMethod: "get_observation",
  actionKeys: fields.map((field) => field.actionKey),
  observationKeys: fields.map((field) => field.observationKey),
  jointOrder: [...JOINT_ORDER],
  fields,
  simulationRest: { ...SIMULATION_REST },
  gripper: {
    jointId: "gripper",
    rendererNode: SO101_MESH_DATA.gripper.node,
    toolFrameNode: "wrist_roll",
    toolOffsetMm: [1.359, -97.71, 0.185],
    toolOffsetBasis: "Closed-pinch midpoint of independently selected distal fixed-jaw and moving-jaw transformed mesh features, expressed in the fixed wrist_roll frame",
    actionKey: "gripper.pos",
    openValue: Number(SO101_MESH_DATA.gripper.openValue),
    graspValue: Number(SO101_MESH_DATA.gripper.closeValue),
    rendererOpenDeg: Number(SO101_MESH_DATA.gripper.openDeg),
    rendererClosedDeg: Number(SO101_MESH_DATA.gripper.closedDeg),
    contactGeometry: {
      schema: "robobuddy.so101-opposed-jaw-geometry.v1",
      axisInToolFrame: [1, 0, 0],
      fixedWitness: {
        role: "fixed_contact_patch",
        bodyId: "gripper_link__wrist_roll_follower_so101_v1_stl_1",
        frameId: "wrist_roll",
        localPointMm: [-8.29564129091325, -101.85084540603893, -2.8515713146747466],
      },
      movingWitness: {
        role: "moving_contact_patch",
        bodyId: "moving_jaw_so101_v1_link__moving_jaw_so101_v1_stl_0",
        frameId: "gripper_jaw",
        localPointMm: [-12.143, 22.344998855573355, 78.19799673456932],
      },
      fixedWitnessInToolFrameMm: [-9.65464129091325, -4.14084540603893, -3.0365713146747465],
      maximumFacePenetrationMm: 1,
      contactToleranceMm: 1.5,
      alignmentToleranceDeg: 14,
      provenance: "Independently selected first-contact surface witnesses from the baked fixed-jaw and moving-jaw meshes; values are renderer geometry, not hardware force or compliance calibration",
    },
    provenance: "RoboBuddy visualization/grasp configuration; not a universal physical open/close constant"
  },
  calibration: {
    requiredByPhysicalSoftware: true,
    physicalRanges: "device_specific",
    simulationStatus: "configured_reference_only",
    restIsPhysicalHome: false,
    statement: "The simulation rest pose is not a physical home or calibration result. LeRobot calibration stores device-specific homing offsets, drive modes, and ranges."
  },
  commandShape: {
    advertisedActionFeatures: "all_six_position_fields",
    directActionMinimumFields: 1,
    directActionMayBePartial: true,
    uncommandedPhysicalBehavior: "SOFollower does not include an unprovided motor in that Goal_Position sync_write.",
    uncommandedSimulationBehavior: "RoboBuddy retains each uncommanded joint at its current simulated position.",
    unknownFieldSimulationBehavior: "RoboBuddy rejects unknown fields instead of silently ignoring non-position metadata."
  },
  normalization: {
    pinnedDefaultUseDegrees: true,
    bodyModeModeled: "DEGREES",
    alternativePhysicalBodyMode: "RANGE_M100_100",
    alternativeModeModeled: false,
    gripperMode: "RANGE_0_100"
  },
  relativeTargetGuard: {
    physicalConfigParameter: "max_relative_target",
    pinnedDefault: null,
    physicalBehavior: "When configured, SOFollower may clip supplied goals relative to a fresh Present_Position read and returns the clipped action actually sent.",
    simulationBehavior: "Not modeled. RoboBuddy applies its explicit URDF-envelope and collision guardrails, then returns the accepted supplied targets unchanged."
  },
  timing: {
    physicalSemantics: "Each LeRobot send_action call writes the supplied Goal_Position subset, optionally clipped by max_relative_target; motor/controller timing is not modeled by the physical API surface.",
    simulationSemantics: "RoboBuddy linearly interpolates between accepted targets only to make awaited command order visible. This is not servo dynamics or a hardware timing guarantee."
  },
  sources: {
    lerobot: {
      revision: LEROBOT_REVISION,
      robotUrl: `https://github.com/huggingface/lerobot/blob/${LEROBOT_REVISION}/src/lerobot/robots/so_follower/so_follower.py`,
      configUrl: `https://github.com/huggingface/lerobot/blob/${LEROBOT_REVISION}/src/lerobot/robots/so_follower/config_so_follower.py`
    },
    urdf: {
      revision: URDF_REVISION,
      url: `https://github.com/TheRobotStudio/SO-ARM100/blob/${URDF_REVISION}/Simulation/SO101/so101_new_calib.urdf`
    }
  },
  evidenceBoundary: {
    sourceStated: [
      "six ordered position action/observation fields",
      "body joint positions use degrees with the pinned use_degrees=true default; RANGE_M100_100 is an alternative configuration",
      "gripper position uses calibrated RANGE_0_100 normalization",
      "send_action filters the supplied .pos fields, writes that Goal_Position subset, and returns the action actually sent",
      "configured max_relative_target may clip a supplied action relative to fresh position feedback",
      "calibration is device-specific"
    ],
    simulationChoices: [
      "URDF mechanical limits as the browser validation envelope",
      "degree-mode body commands only; use_degrees=false is not simulated",
      "non-empty recognized action subsets retain uncommanded simulated joint state",
      "unknown fields are rejected fail-closed",
      "max_relative_target clipping is not simulated",
      "configured rest pose",
      "linear visual interpolation",
      "collision rejection",
      "IK-based task helper decomposition",
      "configured gripper open/grasp values"
    ]
  }
});

const fieldByActionKey = new Map(SO101_COMMAND_MODEL.fields.map((field) => [field.actionKey, field]));

export function so101JointStateToAction(jointState = {}) {
  return Object.fromEntries(SO101_COMMAND_MODEL.fields.map((field) => [
    field.actionKey,
    Number(jointState[field.jointId] ?? field.simulationRest)
  ]));
}

export function so101ActionToJointState(action = {}) {
  return Object.fromEntries(SO101_COMMAND_MODEL.fields
    .filter((field) => Object.hasOwn(action, field.actionKey))
    .map((field) => [field.jointId, Number(action[field.actionKey])]));
}

export function validateSo101Action(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return { ok: false, code: "INVALID_ACTION", message: "send_action requires an object containing one or more recognized <joint>.pos fields." };
  }
  const keys = Object.keys(action);
  const unknown = keys.filter((key) => !fieldByActionKey.has(key));
  if (unknown.length) return { ok: false, code: "INVALID_ACTION_FIELD", message: `Unknown SO-101 action field(s): ${unknown.join(", ")}.` };
  const suppliedFields = SO101_COMMAND_MODEL.fields.filter((field) => Object.hasOwn(action, field.actionKey));
  if (!suppliedFields.length) return { ok: false, code: "EMPTY_ACTION", message: "SO-101 send_action requires at least one recognized <joint>.pos field." };
  for (const field of suppliedFields) {
    const rawValue = action[field.actionKey];
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
      return { ok: false, code: "INVALID_ACTION_VALUE", message: `${field.actionKey} must be a finite JSON number.` };
    }
    const value = rawValue;
    if (value < field.min || value > field.max) {
      return {
        ok: false,
        code: "ACTION_RANGE",
        message: `${field.actionKey}=${value} is outside the ${field.min}..${field.max} ${field.unit} simulation envelope.`,
        field: field.actionKey,
        min: field.min,
        max: field.max,
        unit: field.unit
      };
    }
  }
  return {
    ok: true,
    code: "ACTION_VALID",
    action: Object.fromEntries(suppliedFields.map((field) => [field.actionKey, Number(action[field.actionKey])]))
  };
}
