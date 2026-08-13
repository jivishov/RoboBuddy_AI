import { ARM_RIG_CONFIG } from "../../simulator/js/arm-rig-config.js";
import { ARM_PREVIEW_MESH_DATA } from "../../simulator/js/arm-preview-mesh-data.js";
import { ROBOT_RIG_PREVIEW_CONFIGS } from "../../simulator/js/robot-rig-configs.js";
import { ROBOT_RIG_MESH_DATA as SO101_MESH_DATA } from "../../simulator/js/robot-mesh-data-so101.js";
import { ROBOT_RIG_MESH_DATA as LEKIWI_MESH_DATA } from "../../simulator/js/robot-mesh-data-lekiwi.js";
import { deepClone, deepFreeze } from "./math.js";
import { geometryProbesFromArduinoRig, geometryProbesFromOfficialMesh } from "./render-geometry-probes.js";

const joint = (id, min, max, home, extra = {}) => ({ id, min, max, home, unit: "deg", ...extra });

const ARDUINO_JOINT_IDS = ["base", "shoulder", "elbow", "wrist_rot", "wrist_tilt", "gripper"];
const ARDUINO_CHAIN_IDS = ["baseYaw", "shoulderPitch", "elbowPitch", "wristRotate", "wristTilt"];

function arduinoChain() {
  const chain = ARM_RIG_CONFIG.kinematicChain.map((item, index) => ({
    id: item.id,
    jointId: ARDUINO_JOINT_IDS[index],
    parent: item.parent,
    pivotMm: [...item.pivot],
    axis: [...item.axis],
    sign: Number(item.visualSign ?? 1) * (ARM_RIG_CONFIG.firmware.reversed[index] ? -1 : 1),
    zeroDeg: Number(ARM_RIG_CONFIG.firmware.home[index]),
    offsetDeg: Number(item.offsetDeg || 0),
    baseQuat: [0, 0, 0, 1],
    limitsDeg: [...ARM_RIG_CONFIG.firmware.limits[index]]
  }));
  chain.push({
    id: "tool",
    jointId: null,
    parent: ARDUINO_CHAIN_IDS.at(-1),
    pivotMm: [0, 77, 0],
    axis: [0, 1, 0],
    sign: 0,
    baseQuat: [0, 0, 0, 1]
  });
  return chain;
}

function previewChain(robotId) {
  const config = ROBOT_RIG_PREVIEW_CONFIGS[robotId] || {};
  return (ROBOT_RIG_PREVIEW_CONFIGS[robotId]?.chain || []).map((item) => ({
    id: item.id,
    jointId: item.jointId || null,
    parent: item.parent,
    pivotMm: [...(item.pivotMm || item.pivot || [0, 0, 0])],
    axis: [...(item.axis || [0, 1, 0])],
    sign: Number(item.sign ?? 1),
    zeroDeg: Number(config.visualZeroJoints?.[item.jointId] || 0),
    offsetDeg: Number(item.offsetDeg || 0),
    baseQuat: [...(item.baseQuat || [0, 0, 0, 1])],
    limitsDeg: item.limitsDeg ? [...item.limitsDeg] : undefined,
    source: item.source ? deepClone(item.source) : undefined
  }));
}

const ARM_JOINTS_RAW = {
  arduino_arm: [
    joint("base", 20, 130, 90), joint("shoulder", 15, 165, 90), joint("elbow", 0, 180, 90),
    joint("wrist_rot", 0, 180, 90), joint("wrist_tilt", 0, 180, 90), joint("gripper", 25, 130, 90, { type: "gripper", open: 50, close: 120 })
  ],
  so101_follower: [
    joint("shoulder_pan", -90, 90, 0), joint("shoulder_lift", -90, 90, -90), joint("elbow_flex", -120, 120, 85),
    joint("wrist_flex", -90, 90, 72), joint("wrist_roll", -180, 180, 88), joint("gripper", 0, 100, 85, { type: "gripper", open: 20, close: 85, unit: "percent" })
  ],
  lekiwi_sim: [
    joint("shoulder_pan", -90, 90, 0), joint("shoulder_lift", -90, 90, 0), joint("elbow_flex", -120, 120, 0),
    joint("wrist_flex", -90, 90, 0), joint("wrist_roll", -90, 90, 0), joint("gripper", 0, 100, 50, { type: "gripper", open: 20, close: 85, unit: "percent" })
  ],
  openarm_v2_bimanual: [
    joint("base_yaw", -180, 180, 0),
    joint("left_j1", -200, 80, -25), joint("left_j2", -190, 10, -35), joint("left_j3", -90, 90, 0), joint("left_j4", 0, 140, 75), joint("left_j5", -90, 90, 0), joint("left_j6", -45, 45, -5), joint("left_j7", -90, 90, 0), joint("left_gripper", 0, 45, 12, { type: "gripper", side: "left", open: 45, close: 0 }),
    joint("right_j1", -80, 200, 25), joint("right_j2", -10, 190, 35), joint("right_j3", -90, 90, 0), joint("right_j4", 0, 140, 75), joint("right_j5", -90, 90, 0), joint("right_j6", -45, 45, 5), joint("right_j7", -90, 90, 0), joint("right_gripper", 0, 45, 12, { type: "gripper", side: "right", open: 45, close: 0 })
  ],
  unitree_g1_29dof: []
};

const LIMIT_PROVENANCE = Object.freeze({
  arduino_arm: "M: firmware limits in ARM_RIG_CONFIG 2026-06-11; configured chain is not certified calibration.",
  so101_follower: "M: official-model joint definitions; C: conservative educational limits configured in RoboBuddy, not certified calibrated limits.",
  lekiwi_sim: "M: official-model arm joint definitions; C: configured educational arm limits and planar base bounds.",
  openarm_v2_bimanual: "M: baked official-model joint chain; C: RoboBuddy shared-base and educational joint-limit configuration.",
  unitree_g1_29dof: "C: no learner joint-limit control is exposed; motion is restricted to authored waypoint, turn, dock, and latch frames."
});

const ARM_JOINTS = Object.freeze(Object.fromEntries(Object.entries(ARM_JOINTS_RAW).map(([robotId, joints]) => [
  robotId,
  joints.map((item) => ({ ...item, limitProvenance: LIMIT_PROVENANCE[robotId] }))
])));

const SOURCES = {
  arduino_arm: {
    kind: "CAD-derived configured chain",
    revision: "ARM_RIG_CONFIG 2026-06-11",
    path: "simulator/js/arm-rig-config.js",
    provenance: "M",
    notes: "Measured STEP assembly pivots and firmware limits; not certified calibration."
  },
  so101_follower: {
    kind: "official URDF baked model",
    revision: "SO101 official main snapshot baked 2026-07-02",
    url: "https://github.com/TheRobotStudio/SO-ARM100/blob/main/Simulation/SO101/so101_new_calib.urdf",
    provenance: "M",
    notes: "Official joint chain; configured educational limits are explicitly separate from calibrated hardware limits."
  },
  lekiwi_sim: {
    kind: "official URDF baked model",
    revision: "LeKiwi official snapshot baked 2026-07-03",
    url: "https://github.com/SIGRobotics-UIUC/LeKiwi/blob/main/URDF/LeKiwi.urdf",
    provenance: "M",
    notes: "Official visual/kinematic chain with configured planar occupancy-grid base model."
  },
  openarm_v2_bimanual: {
    kind: "official collision meshes and baked chain",
    revision: "6c7b720f1ba48e8bafa3a3dc752c45f397b42221",
    url: "https://github.com/enactic/openarm_description/tree/6c7b720f1ba48e8bafa3a3dc752c45f397b42221",
    provenance: "M",
    notes: "Official arm collision meshes; 550 mm stand and shared turntable are configured RoboBuddy modifications."
  },
  unitree_g1_29dof: {
    kind: "official URDF baked model",
    revision: "dd4fa6866e523ad61324f658d63736e4eda3a6e4",
    url: "https://github.com/unitreerobotics/unitree_ros/blob/dd4fa6866e523ad61324f658d63736e4eda3a6e4/robots/g1_description/g1_29dof.urdf",
    provenance: "M",
    notes: "Official visual chain used only for constrained waypoint logistics visualization."
  }
};

function capsuleProxies(chain, radiusMm = 34, prefix = "link") {
  const proxyChain = chain.filter((item) => item.parent && item.parent !== "root");
  return proxyChain.map((item, index) => ({
    id: `${prefix}-${index + 1}`,
    type: "capsule",
    fromFrame: item.parent,
    toFrame: item.id,
    radiusMm,
    provenance: "C: conservative link envelope around canonical joint pivots"
  }));
}

function baseModel(id, options) {
  const chain = options.chain || [];
  const model = {
    schema: "robobuddy.robot-model.v2",
    id,
    units: "mm-deg",
    rootMotion: options.rootMotion || "fixed",
    source: SOURCES[id],
    joints: ARM_JOINTS[id] || [],
    chains: options.chains || {
      default: {
        id: "default",
        joints: chain,
        endFrame: options.endFrame || chain.at(-1)?.id || "root"
      }
    },
    rendererBinding: options.rendererBinding,
    collisionProxies: options.collisionProxies || capsuleProxies(chain, options.proxyRadiusMm),
    capabilities: options.capabilities,
    fidelity: options.fidelity,
    unsupportedPhysics: options.unsupportedPhysics,
    configured: options.configured || {},
    rendererChain: options.rendererChain || undefined,
    rendererRootOffsetMm: options.rendererRootOffsetMm || [0, 0, 0],
    renderGeometrySamples: options.renderGeometrySamples || []
  };
  return deepFreeze(model);
}

const ARDUINO_CHAIN = arduinoChain();
const ARDUINO_GEOMETRY = geometryProbesFromArduinoRig(ARM_RIG_CONFIG, ARM_PREVIEW_MESH_DATA);
const SO101_RENDERER_CHAIN = normalizeMeshChain(SO101_MESH_DATA.chain);
const LEKIWI_RENDERER_CHAIN = normalizeMeshChain(LEKIWI_MESH_DATA.chain);
const SO101_CHAIN = SO101_RENDERER_CHAIN.filter((item) => ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper_jaw"].includes(item.id));
const LEKIWI_CHAIN = LEKIWI_RENDERER_CHAIN.filter((item) => ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper_jaw"].includes(item.id));
const SO101_GEOMETRY = geometryProbesFromOfficialMesh(SO101_MESH_DATA, { prefix: "render-so101" });
const LEKIWI_GEOMETRY = geometryProbesFromOfficialMesh(LEKIWI_MESH_DATA, { prefix: "render-lekiwi" });

const STATIC_MODELS = {
  arduino_arm: baseModel("arduino_arm", {
    chain: ARDUINO_CHAIN,
    endFrame: "tool",
    rendererBinding: { kind: "arm-rig-config", revision: "2026-06-11", chainField: "kinematicChain" },
    collisionProxies: [...capsuleProxies(ARDUINO_CHAIN, 31), ...ARDUINO_GEOMETRY.collisionProxies],
    rendererRootOffsetMm: ARDUINO_GEOMETRY.rendererRootOffsetMm,
    renderGeometrySamples: ARDUINO_GEOMETRY.renderGeometrySamples,
    capabilities: ["fixed_base_fk", "position_ik", "joint_path", "linkage_gripper", "contact_sequences"],
    fidelity: "CAD-derived kinematic chain with conservative collision envelopes",
    unsupportedPhysics: ["certified calibration", "servo dynamics", "force control", "payload certification"],
    configured: { gripperLinkage: deepClone(ARM_RIG_CONFIG.gripperLinkage) }
  }),
  so101_follower: baseModel("so101_follower", {
    chain: SO101_CHAIN,
    endFrame: "gripper_jaw",
    rendererBinding: { kind: "official-baked-mesh-chain", revision: ROBOT_RIG_PREVIEW_CONFIGS.so101_follower.meshData.version, sourceUrl: SO101_MESH_DATA.source.urdf },
    rendererChain: SO101_RENDERER_CHAIN,
    collisionProxies: [...capsuleProxies(SO101_CHAIN, 34), ...SO101_GEOMETRY.collisionProxies],
    rendererRootOffsetMm: SO101_GEOMETRY.rendererRootOffsetMm,
    renderGeometrySamples: SO101_GEOMETRY.renderGeometrySamples,
    capabilities: ["fixed_base_fk", "position_ik", "joint_path", "fixture_assisted_grasp", "contact_sequences"],
    fidelity: "Official-model kinematic chain with configured educational joint limits",
    unsupportedPhysics: ["force sensing", "payload claim", "servo dynamics", "certified calibrated limits"]
  }),
  lekiwi_sim: baseModel("lekiwi_sim", {
    chain: LEKIWI_CHAIN,
    endFrame: "gripper_jaw",
    rootMotion: "planar",
    rendererBinding: { kind: "official-baked-mesh-chain", revision: ROBOT_RIG_PREVIEW_CONFIGS.lekiwi_sim.meshData.version, sourceUrl: LEKIWI_MESH_DATA.source.urdf },
    rendererChain: LEKIWI_RENDERER_CHAIN,
    collisionProxies: [...capsuleProxies(LEKIWI_CHAIN, 34), ...LEKIWI_GEOMETRY.collisionProxies],
    rendererRootOffsetMm: LEKIWI_GEOMETRY.rendererRootOffsetMm,
    renderGeometrySamples: LEKIWI_GEOMETRY.renderGeometrySamples,
    capabilities: ["occupancy_grid_astar", "stow_before_drive", "arm_fk", "position_ik", "joint_path", "grasping", "contact_sequences"],
    fidelity: "Planar occupancy-grid base and official-model arm kinematics",
    unsupportedPhysics: ["wheel slip", "base dynamics", "force sensing", "payload claim"],
    configured: { footprintRadiusMm: 215, gridResolutionMm: 50, stowJointState: Object.fromEntries(ARM_JOINTS.lekiwi_sim.map((item) => [item.id, item.home])) }
  }),
  openarm_v2_bimanual: baseModel("openarm_v2_bimanual", {
    chains: {},
    rendererBinding: { kind: "baked-mesh-chain", revision: SOURCES.openarm_v2_bimanual.revision },
    capabilities: ["per_arm_fk", "position_ik", "joint_path", "coordinated_bimanual", "shared_base_constraints", "contact_sequences"],
    fidelity: "Per-arm and coordinated bimanual kinematics with a shared configured base",
    unsupportedPhysics: ["torque control", "force control", "payload claim", "certified mechanical stand"]
  }),
  unitree_g1_29dof: baseModel("unitree_g1_29dof", {
    chains: {},
    rootMotion: "constrained-waypoint",
    rendererBinding: { kind: "baked-mesh-chain", revision: SOURCES.unitree_g1_29dof.revision },
    collisionProxies: [
      { id: "body", type: "box", frameId: "root", centerMm: [0, -82.266, 0], halfExtentsMm: [260, 710, 235], provenance: "C: conservative full-body waypoint envelope" },
      { id: "secured-carrier", type: "box", frameId: "root", centerMm: [285, 32.734, 0], halfExtentsMm: [210, 145, 260], provenance: "C: configured locked-carrier envelope" }
    ],
    capabilities: ["constrained_waypoints", "turns", "docking", "secured_carrier_attachment"],
    fidelity: "Constrained waypoint logistics with discrete dock/latch events",
    unsupportedPhysics: ["free grasping", "leg IK", "dynamic balance", "collision recovery", "dynamic locomotion", "force control"],
    configured: { footprintRadiusMm: 390, carrierInterface: "robobuddy-secured-carrier-v2" }
  })
};

function splitOpenArmChains(chain) {
  const shared = chain.filter((item) => item.id === "base_yaw");
  const side = (name) => chain.filter((item) => /^.+_j[1-7]$/.test(item.id) && item.id.startsWith(`${name}_`));
  const make = (name) => ({
    id: name,
    joints: [...shared, ...chain.filter((item) => item.id === `${name}_mount`), ...side(name)],
    endFrame: `${name}_j7`
  });
  return { left: make("left"), right: make("right") };
}

function normalizeMeshChain(chain) {
  return chain.map((item) => ({
    id: item.id,
    jointId: item.jointId || null,
    parent: item.parent,
    pivotMm: [...(item.pivotMm || [0, 0, 0])],
    axis: [...(item.axis || [0, 1, 0])],
    sign: Number(item.sign ?? 1),
    zeroDeg: 0,
    offsetDeg: Number(item.offsetDeg || 0),
    baseQuat: [...(item.baseQuat || [0, 0, 0, 1])],
    limitsDeg: item.limitsDeg ? [...item.limitsDeg] : undefined,
    sourceJoint: item.sourceJoint || undefined
  }));
}

const loadedModels = new Map(Object.entries(STATIC_MODELS).filter(([id]) => !["openarm_v2_bimanual", "unitree_g1_29dof"].includes(id)));

export const ROBOT_MODEL_CATALOG = deepFreeze(STATIC_MODELS);

export function getRobotModel(robotId) {
  return loadedModels.get(robotId) || ROBOT_MODEL_CATALOG[robotId] || null;
}

export async function loadRobotModel(robotId) {
  if (loadedModels.has(robotId)) return loadedModels.get(robotId);
  const base = ROBOT_MODEL_CATALOG[robotId];
  if (!base) throw new Error(`Unknown canonical robot model: ${robotId}`);
  if (robotId === "openarm_v2_bimanual") {
    const module = await import("../../simulator/js/robot-mesh-data-openarm-v2.js");
    const mesh = module.ROBOT_RIG_MESH_DATA;
    if (mesh.source?.revision !== base.source.revision) throw new Error("OpenArm baked model revision does not match the canonical claim.");
    const meshChain = normalizeMeshChain(mesh.chain);
    const chains = splitOpenArmChains(meshChain);
    const renderGeometry = geometryProbesFromOfficialMesh(mesh, { prefix: "render-openarm" });
    const collisionProxies = [
      ...capsuleProxies(chains.left.joints, 42, "left-link"),
      ...capsuleProxies(chains.right.joints, 42, "right-link"),
      { id: "shared-base", type: "box", centerMm: [0, 290, 0], halfExtentsMm: [205, 290, 205], provenance: "C: conservative configured stand envelope" },
      ...renderGeometry.collisionProxies
    ];
    const model = deepFreeze({
      ...deepClone(base),
      chains,
      collisionProxies,
      rendererChain: meshChain,
      rendererBoundsMm: [...mesh.bboxMm],
      rendererRootOffsetMm: renderGeometry.rendererRootOffsetMm,
      renderGeometrySamples: renderGeometry.renderGeometrySamples
    });
    loadedModels.set(robotId, model);
    return model;
  }
  if (robotId === "unitree_g1_29dof") {
    const module = await import("../../simulator/js/robot-mesh-data-unitree-g1.js");
    const mesh = module.ROBOT_RIG_MESH_DATA;
    if (mesh.source?.revision !== base.source.revision) throw new Error("G1 baked model revision does not match the canonical claim.");
    const renderGeometry = geometryProbesFromOfficialMesh(mesh, { prefix: "render-g1" });
    const model = deepFreeze({
      ...deepClone(base),
      collisionProxies: [...deepClone(base.collisionProxies), ...renderGeometry.collisionProxies],
      rendererChain: normalizeMeshChain(mesh.chain),
      rendererBoundsMm: [...mesh.bboxMm],
      rendererRootOffsetMm: renderGeometry.rendererRootOffsetMm,
      renderGeometrySamples: renderGeometry.renderGeometrySamples
    });
    loadedModels.set(robotId, model);
    return model;
  }
  return base;
}

export async function canonicalRendererData(robotId, rendererData) {
  const model = await loadRobotModel(robotId);
  if (!rendererData || typeof rendererData !== "object") throw new Error(`Renderer data missing for ${robotId}.`);
  if (model.rendererBinding.kind === "baked-mesh-chain") {
    const revision = rendererData.source?.revision;
    if (revision !== model.source.revision) throw new Error(`${robotId} renderer revision ${revision || "unknown"} does not match canonical revision ${model.source.revision}.`);
    return { ...rendererData, chain: deepClone(model.rendererChain) };
  }
  if (model.rendererBinding.kind === "official-baked-mesh-chain") {
    if (rendererData.source?.urdf !== model.rendererBinding.sourceUrl) {
      throw new Error(`${robotId} renderer source does not match the canonical baked model source.`);
    }
    return { ...rendererData, chain: deepClone(model.rendererChain) };
  }
  const field = model.rendererBinding.chainField;
  const actual = rendererData[field] || [];
  const expected = model.chains.default?.joints || [];
  if (actual.length !== expected.filter((item) => item.id !== "tool").length) {
    throw new Error(`${robotId} renderer chain length does not match the canonical catalog.`);
  }
  return rendererData;
}

export function homeJointState(model) {
  return Object.fromEntries((model.joints || []).map((item) => [item.id, item.home]));
}

export function modelClaim(robotId) {
  const model = getRobotModel(robotId);
  if (!model) return null;
  return deepClone({
    modelId: model.id,
    source: model.source,
    joints: model.joints.map(({ id, min, max, home, unit, type, limitProvenance }) => ({ id, min, max, home, unit, type: type || "revolute", limitProvenance })),
    limitProvenance: LIMIT_PROVENANCE[robotId],
    frames: Object.values(model.chains).flatMap((chain) => chain.joints.map((item) => item.id)),
    collisionProxyProvenance: [...new Set(model.collisionProxies.map((item) => item.provenance))],
    supportedFidelity: model.fidelity,
    unsupportedPhysics: model.unsupportedPhysics
  });
}
