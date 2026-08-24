import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScenarioV2Engine,
  SO101_COMMAND_MODEL,
  collisionGeometry,
  compileV2BlocklyProgram,
  forwardKinematics,
  homeJointState,
  loadRobotModel,
  modelClaim,
  stateCollisionReport,
  validateProxyEnclosure,
  validateSo101Action
} from "../../../lab/v2/index.js";
import { add3, rotate3, rotationFromQuaternion, transformPoint } from "../../../lab/v2/math.js";
import { ROBOT_RIG_MESH_DATA as SO101_MESH_DATA } from "../../../simulator/js/robot-mesh-data-so101.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFINITIONS = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "so101");
const GENERATED = resolve(ROOT, "missions", "lab-assistant", "v2", "generated", "scenarios");
const files = (await readdir(DEFINITIONS)).filter((name) => name.endsWith(".json")).sort();
const definitions = await Promise.all(files.map(async (name) => JSON.parse(await readFile(resolve(DEFINITIONS, name), "utf8"))));

// Independent literals transcribed from the pinned LeRobot SOFollower mapping
// and official SO-101 URDF. The canonical declaration cannot make this test
// pass merely by changing itself.
const AUTHORIZED_ORDER = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];
const AUTHORIZED_ACTION_KEYS = AUTHORIZED_ORDER.map((jointId) => `${jointId}.pos`);
const AUTHORIZED_MOTOR_IDS = [1, 2, 3, 4, 5, 6];
const AUTHORIZED_UNITS = ["deg", "deg", "deg", "deg", "deg", "normalized_0_100"];
const AUTHORIZED_PINNED_USE_DEGREES_DEFAULT = true;
const AUTHORIZED_PINNED_MAX_RELATIVE_TARGET_DEFAULT = null;
const AUTHORIZED_URDF_LIMITS = {
  shoulder_pan: [-110, 110],
  shoulder_lift: [-100, 100],
  elbow_flex: [-96.83, 96.83],
  wrist_flex: [-95, 95],
  wrist_roll: [-157.21, 162.79]
};
const RENDERED_GRIP_Y_MM = {
  weigh_boat: 7,
  bottle: 48,
  flask: 68,
  filter_flask: 68,
  cuvette: 44,
  secured_carrier: 39,
  pipette_pump: 50
};

assert.deepEqual(SO101_COMMAND_MODEL.jointOrder, AUTHORIZED_ORDER);
assert.deepEqual(SO101_COMMAND_MODEL.actionKeys, AUTHORIZED_ACTION_KEYS);
assert.deepEqual(SO101_COMMAND_MODEL.observationKeys, AUTHORIZED_ACTION_KEYS);
assert.deepEqual(SO101_COMMAND_MODEL.fields.map((field) => field.motorId), AUTHORIZED_MOTOR_IDS);
assert.deepEqual(SO101_COMMAND_MODEL.fields.map((field) => field.unit), AUTHORIZED_UNITS);
assert.equal(SO101_COMMAND_MODEL.sources.lerobot.revision, "7e241bd630a3719a56157a497ce5d08f244784f1");
assert.equal(SO101_COMMAND_MODEL.sources.urdf.revision, "7629d2ad9853d10fb903093a33ef6114099d97e5");
assert.equal(SO101_COMMAND_MODEL.calibration.physicalRanges, "device_specific");
assert.equal(SO101_COMMAND_MODEL.calibration.restIsPhysicalHome, false);
assert.equal(SO101_COMMAND_MODEL.normalization.pinnedDefaultUseDegrees, AUTHORIZED_PINNED_USE_DEGREES_DEFAULT);
assert.equal(SO101_COMMAND_MODEL.normalization.alternativeModeModeled, false);
assert.equal(SO101_COMMAND_MODEL.commandShape.directActionMayBePartial, true);
assert.equal(SO101_COMMAND_MODEL.relativeTargetGuard.pinnedDefault, AUTHORIZED_PINNED_MAX_RELATIVE_TARGET_DEFAULT);
assert.match(SO101_COMMAND_MODEL.relativeTargetGuard.simulationBehavior, /Not modeled/);

const meshBodyJoints = SO101_MESH_DATA.chain.filter((joint) => joint.jointId);
const meshEffectorNode = SO101_MESH_DATA.chain.at(-1).id;
assert.equal(meshEffectorNode, SO101_MESH_DATA.gripper.node, "the rendered effector node must come from the baked mesh hierarchy");
assert.equal(SO101_COMMAND_MODEL.gripper.rendererNode, meshEffectorNode, "SO-101 attachments must follow the actual rendered jaw node");
assert.deepEqual(meshBodyJoints.map((joint) => joint.sourceJoint), AUTHORIZED_ORDER.slice(0, 5), "baked hierarchy order must match the official controllable body order");
meshBodyJoints.forEach((joint) => {
  assert.deepEqual(joint.limitsDeg, AUTHORIZED_URDF_LIMITS[joint.jointId], `${joint.jointId}: baked mechanical limits drifted from the official URDF`);
  const field = SO101_COMMAND_MODEL.fields.find((item) => item.jointId === joint.jointId);
  assert.deepEqual([field.min, field.max], joint.limitsDeg, `${joint.jointId}: command validation and baked mechanical limits diverged`);
  assert.deepEqual(field.rendererAxis, joint.axis, `${joint.jointId}: renderer axis correspondence`);
  assert.equal(field.rendererDirection, joint.sign, `${joint.jointId}: renderer direction correspondence`);
});

const model = await loadRobotModel("so101_follower");
const claim = modelClaim("so101_follower");
assert.deepEqual(model.joints.map((joint) => joint.id), AUTHORIZED_ORDER);
assert.ok(model.capabilities.includes("joint_position_command"));
assert.ok(model.capabilities.includes("position_observation"));
assert.equal(model.capabilities.includes("position_ik"), false, "the native SOFollower action surface must not be presented as Cartesian/IK");
assert.equal(model.capabilities.includes("joint_path"), false, "autonomous planning is not a claimed physical SO-101 capability");
assert.ok(claim.unsupportedPhysics.some((item) => item.includes("controller dynamics")));
assert.ok(claim.unsupportedPhysics.some((item) => item.includes("physical transport")));
assert.ok(claim.unsupportedPhysics.some((item) => item.includes("collision avoidance")));
assert.ok(claim.unsupportedPhysics.some((item) => item.includes("hardware validation")));
assert.equal(validateProxyEnclosure(model, homeJointState(model)).ok, true, "open-rest transformed mesh samples must remain enclosed by moving collision proxies");

function decodedMeshVertices(meshKey) {
  const payload = SO101_MESH_DATA.meshes[meshKey];
  const bytes = Buffer.from(payload.positions, "base64");
  return Array.from({ length: payload.vertexCount }, (_, vertex) => [0, 1, 2].map((axis) => {
    const ratio = bytes.readUInt16LE((vertex * 3 + axis) * 2) / SO101_MESH_DATA.quantization;
    return payload.bounds[axis] + (payload.bounds[axis + 3] - payload.bounds[axis]) * ratio;
  }));
}

function partPoint(part, meshPoint) {
  return add3(part.posMm, rotate3(rotationFromQuaternion(part.quat), meshPoint.map((value) => value * Number(part.scale))));
}

function gripperRendererFk(visualDegrees) {
  const chain = model.rendererChain.map((joint) => joint.id === SO101_MESH_DATA.gripper.node
    ? { ...joint, jointId: "__visual_gripper", sign: 1, zeroDeg: 0, offsetDeg: 0 }
    : joint);
  const rendererModel = { ...model, chains: { renderer: { id: "renderer", joints: chain, endFrame: SO101_MESH_DATA.gripper.node } } };
  return forwardKinematics(rendererModel, { ...homeJointState(model), __visual_gripper: visualDegrees }, { chainId: "renderer" });
}

function featureCentroid(part, vertices, fk) {
  return [0, 1, 2].map((axis) => vertices.reduce((sum, point) => (
    sum + transformPoint(fk.frames[part.group], partPoint(part, point))[axis]
  ), 0) / vertices.length);
}

const fixedJawPart = SO101_MESH_DATA.parts.find((part) => part.meshKey === "wrist_roll_follower_so101_v1");
const movingJawPart = SO101_MESH_DATA.parts.find((part) => part.meshKey === "moving_jaw_so101_v1");
assert.ok(fixedJawPart && movingJawPart, "actual fixed and moving gripper mesh features must exist");
const fixedVertices = decodedMeshVertices(fixedJawPart.meshKey);
const movingVertices = decodedMeshVertices(movingJawPart.meshKey);
const fixedMaxY = Math.max(...fixedVertices.map((point) => point[1]));
const movingMaxZ = Math.max(...movingVertices.map((point) => point[2]));
const fixedDistal = fixedVertices.filter((point) => point[1] >= fixedMaxY * 0.86);
const movingDistal = movingVertices.filter((point) => point[2] >= movingMaxZ * 0.86);
assert.ok(fixedDistal.length > 250 && movingDistal.length > 200, "named distal features need enough baked vertices for a non-label geometry check");

const openFk = gripperRendererFk(SO101_MESH_DATA.gripper.openDeg);
const closedFk = gripperRendererFk(SO101_MESH_DATA.gripper.closedDeg);
const fixedTip = featureCentroid(fixedJawPart, fixedDistal, openFk);
const openTip = featureCentroid(movingJawPart, movingDistal, openFk);
const closedTip = featureCentroid(movingJawPart, movingDistal, closedFk);
const openGap = Math.hypot(...fixedTip.map((value, axis) => value - openTip[axis]));
const closedGap = Math.hypot(...fixedTip.map((value, axis) => value - closedTip[axis]));
assert.ok(openGap > 110, `transformed moving-jaw geometry is not visibly open (${openGap.toFixed(2)} mm)`);
assert.ok(closedGap < 35, `transformed moving-jaw geometry does not close toward the fixed jaw (${closedGap.toFixed(2)} mm)`);
assert.ok(openGap - closedGap > 80, "gripper convention must come from transformed mesh motion, not open/close labels");
const closedPinch = fixedTip.map((value, axis) => (value + closedTip[axis]) / 2);
const toolFrame = closedFk.frames[SO101_COMMAND_MODEL.gripper.toolFrameNode];
const pinchDelta = closedPinch.map((value, axis) => value - toolFrame.position[axis]);
const pinchOffsetFromMesh = [
  toolFrame.rotation[0] * pinchDelta[0] + toolFrame.rotation[3] * pinchDelta[1] + toolFrame.rotation[6] * pinchDelta[2],
  toolFrame.rotation[1] * pinchDelta[0] + toolFrame.rotation[4] * pinchDelta[1] + toolFrame.rotation[7] * pinchDelta[2],
  toolFrame.rotation[2] * pinchDelta[0] + toolFrame.rotation[5] * pinchDelta[1] + toolFrame.rotation[8] * pinchDelta[2]
];
SO101_COMMAND_MODEL.gripper.toolOffsetMm.forEach((value, axis) => assert.ok(Math.abs(value - pinchOffsetFromMesh[axis]) < 0.01, "canonical fixed tool socket must come from transformed jaw features"));
assert.equal(model.chains.default.endFrame, SO101_COMMAND_MODEL.gripper.toolFrameNode, "planner/FK must use the fixed tool frame");
assert.deepEqual(model.chains.default.endOffsetMm, SO101_COMMAND_MODEL.gripper.toolOffsetMm, "planner/FK must consume the canonical pinch socket");

const openState = { ...homeJointState(model), gripper: SO101_COMMAND_MODEL.gripper.openValue };
const closedState = { ...homeJointState(model), gripper: SO101_COMMAND_MODEL.gripper.graspValue };
const openProxy = collisionGeometry(model, openState).find((proxy) => proxy.id === "render-so101-gripper_jaw");
const closedProxy = collisionGeometry(model, closedState).find((proxy) => proxy.id === "render-so101-gripper_jaw");
assert.ok(openProxy && closedProxy, "moving gripper collision proxy missing");
assert.ok(Math.hypot(...openProxy.centerMm.map((value, axis) => value - closedProxy.centerMm[axis])) > 25, "gripper collision proxy must follow the renderer jaw rotation");
[openProxy, closedProxy].forEach((proxy, index) => {
  const tip = index === 0 ? openTip : closedTip;
  const offset = tip.map((value, axis) => value - proxy.centerMm[axis]);
  const local = proxy.axes.map((axis) => axis.reduce((sum, value, component) => sum + value * offset[component], 0));
  local.forEach((value, axis) => assert.ok(Math.abs(value) <= proxy.halfExtentsMm[axis] + 0.5, "transformed jaw feature escaped its oriented moving collision proxy"));
});

for (const definition of definitions) {
  const obstacles = definition.fixtures.filter((fixture) => fixture.id !== "so101_base_mount").flatMap((fixture) => (
    fixture.collisionProxies || (fixture.collisionProxy ? [fixture.collisionProxy] : [])
  ).map((proxy, index) => ({ id: `${fixture.id}:${proxy.id || index + 1}`, ...proxy })));
  const restClearance = stateCollisionReport(model, homeJointState(model), obstacles);
  assert.equal(restClearance.ok, true, `${definition.id}: all task furniture clears the configured rest envelope`);
  const mount = definition.fixtures.find((fixture) => fixture.id === "so101_base_mount");
  assert.equal(mount.collisionProxy.planningRole, "robot_mount_contact");
  assert.ok(Math.abs(mount.collisionProxy.centerMm[1] + mount.collisionProxy.halfExtentsMm[1]) < 0.001, `${definition.id}: flush mount top must meet the sampled root support plane without lifting the robot`);
  assert.match(mount.description, /opaque flush mounting plate/);
  definition.objects.forEach((object) => {
    const contact = definition.frames[`${object.id}_contact`];
    const place = definition.frames[`${object.id}_place_contact`];
    const destination = definition.frames[`${object.id}_destination`];
    assert.equal(contact.contactFixtureId, `${object.id}_pickup_adapter`);
    assert.equal(place.contactFixtureId, `${object.id}_destination_slot`);
    for (const suffix of ["pickup_adapter", "destination_slot"]) {
      const fixture = definition.fixtures.find((item) => item.id === `${object.id}_${suffix}`);
      assert.equal(fixture.type, "configured_real_work_surface");
      assert.equal(fixture.collisionProxy, undefined, `${fixture.id}: one authoritative worktop proxy`);
      assert.deepEqual(fixture.collisionProxies.map((proxy) => proxy.planningRole), ["contact_surface"]);
      const worktop = fixture.collisionProxies[0];
      const apparatus = object.physicalRest.geometry.halfExtentsMm;
      assert.ok(
        worktop.halfExtentsMm[0] >= apparatus[0] + 2
          && worktop.halfExtentsMm[2] >= apparatus[2] + 2,
        `${fixture.id}: complete apparatus footprint plus minimum edge margin`,
      );
      assert.doesNotMatch(JSON.stringify(fixture), /rear[-_ ]?post|edge[-_ ]?tab|registration[-_ ]?pin/i);
    }
    assert.equal(place.coincidentWith, `${object.id}_destination`);
    assert.ok(destination.positionMm[1] > place.positionMm[1]);
    const expectedGripY = Number(object.physicalRest.gripSocketMm[1]);
    assert.equal(object.visual.directHandling, true);
    assert.equal(object.visual.containerFree, true);
    assert.equal(object.physicalRest.directHandling, true);
    assert.equal(object.physicalRest.containerFree, true);
    assert.notEqual(object.visual.type, "apparatus_transport");
    assert.notEqual(object.visual.type, "secured_carrier");
    assert.deepEqual(object.visual.gripSocketMm, object.physicalRest.gripSocketMm);
    for (const [fixtureId, frame] of [[`${object.id}_pickup_adapter`, contact], [`${object.id}_destination_slot`, place]]) {
      const fixture = definition.fixtures.find((item) => item.id === fixtureId);
      const supportTopY = Math.max(...fixture.collisionProxies.map((proxy) => proxy.centerMm[1] + proxy.halfExtentsMm[1]));
      const renderedBottomY = frame.positionMm[1] - expectedGripY;
      assert.ok(Math.abs(supportTopY - renderedBottomY) < 0.001, `${fixtureId}: visible/collision support top must meet the rendered object bottom`);
    }
  });
}

const first = definitions[0];
const baselineEngine = await ScenarioV2Engine.create(first, { sleep: async () => {} });
const modelResponse = await baselineEngine.call("robot.command_model");
const observationResponse = await baselineEngine.call("robot.get_observation");
assert.equal(modelResponse.code, "COMMAND_MODEL");
assert.deepEqual(modelResponse.commandModel.actionKeys, AUTHORIZED_ACTION_KEYS);
assert.equal(observationResponse.physicalCalibrationConfirmed, false);
assert.equal(observationResponse.calibrationStatus, "configured_reference_only");
assert.deepEqual(Object.keys(observationResponse.observation), AUTHORIZED_ACTION_KEYS);

const targetAction = { ...observationResponse.observation, "shoulder_pan.pos": 12, "wrist_roll.pos": 70 };
const firstSamples = [];
const deterministicEngineA = await ScenarioV2Engine.create(first, { sleep: async () => {}, onSample: (sample) => firstSamples.push(sample.jointState) });
const firstSend = await deterministicEngineA.call("robot.send_action", { action: targetAction, durationMs: 640, sampleCount: 8 });
assert.equal(firstSend.code, "ACTION_SENT");
assert.match(firstSend.message, /shoulder_pan\.pos=.*gripper\.pos=/, "direct action log must expose the ordered LeRobot target fields");
assert.deepEqual(firstSend.observation, targetAction);
const secondSamples = [];
const deterministicEngineB = await ScenarioV2Engine.create(first, { sleep: async () => {}, onSample: (sample) => secondSamples.push(sample.jointState) });
const secondSend = await deterministicEngineB.call("robot.send_action", { action: targetAction, durationMs: 640, sampleCount: 8 });
assert.equal(secondSend.code, "ACTION_SENT");
assert.deepEqual(secondSamples, firstSamples, "identical accepted targets must interpolate deterministically");

const partialEngine = await ScenarioV2Engine.create(first, { sleep: async () => {} });
const partialBefore = (await partialEngine.call("robot.get_observation")).observation;
const partialAction = { "shoulder_pan.pos": 5 };
const partialSend = await partialEngine.call("robot.send_action", { action: partialAction, durationMs: 0 });
assert.equal(partialSend.code, "ACTION_SENT");
assert.deepEqual(partialSend.action, partialAction, "send_action must return only the recognized subset actually sent");
assert.equal(partialSend.observation["shoulder_pan.pos"], 5);
AUTHORIZED_ACTION_KEYS.slice(1).forEach((key) => {
  assert.equal(partialSend.observation[key], partialBefore[key], `${key}: an uncommanded simulated joint must retain its prior state`);
});
assert.equal(partialSend.physicalRelativeTargetClippingModeled, false);
assert.match(partialSend.message, /shoulder_pan\.pos=5\.0/);
assert.doesNotMatch(partialSend.message, /shoulder_lift\.pos=/, "partial action log must not fabricate unsupplied fields");

const invalidActions = [
  [{ ...targetAction, "mystery.pos": 0 }, "INVALID_ACTION_FIELD"],
  [{}, "EMPTY_ACTION"],
  [{ "shoulder_pan.pos": "5" }, "INVALID_ACTION_VALUE"],
  [{ "shoulder_pan.pos": null }, "INVALID_ACTION_VALUE"],
  [{ ...targetAction, "elbow_flex.pos": Number.NaN }, "INVALID_ACTION_VALUE"],
  [{ ...targetAction, "wrist_roll.pos": 999 }, "ACTION_RANGE"]
];
for (const [action, code] of invalidActions) {
  assert.equal(validateSo101Action(action).code, code);
  const engine = await ScenarioV2Engine.create(first, { sleep: async () => {} });
  const before = engine.snapshot().jointState;
  const response = await engine.call("robot.send_action", { action, durationMs: 0 });
  assert.equal(response.code, code);
  assert.deepEqual(engine.snapshot().jointState, before, `${code}: invalid action must not mutate state`);
}

let stopEngine;
let stopSleeps = 0;
stopEngine = await ScenarioV2Engine.create(first, {
  sleep: async () => {
    stopSleeps += 1;
    if (stopSleeps === 1) stopEngine.stop("programmability-test");
  }
});
const stopTarget = { ...observationResponse.observation, "shoulder_pan.pos": 40 };
const stopped = await stopEngine.call("robot.send_action", { action: stopTarget, durationMs: 800, sampleCount: 8 });
assert.equal(stopped.code, "STOPPED");
assert.ok(stopEngine.snapshot().jointState.shoulder_pan > 0 && stopEngine.snapshot().jointState.shoulder_pan < 40, "STOP retains the last executed joint sample");
const reset = await stopEngine.call("robot.reset");
assert.equal(reset.code, "RESET");
assert.deepEqual(stopEngine.snapshot().jointState, homeJointState(model), "reset restores configured simulation rest, not a fabricated physical home result");

let releaseStaleSleep;
const staleEngine = await ScenarioV2Engine.create(first, {
  sleep: async () => new Promise((resolveSleep) => { releaseStaleSleep = resolveSleep; })
});
const staleAction = staleEngine.call("robot.send_action", { action: stopTarget, durationMs: 800, sampleCount: 8 });
while (!releaseStaleSleep) await new Promise((resolveTick) => setImmediate(resolveTick));
const resetDuringAction = await staleEngine.call("robot.reset");
assert.equal(resetDuringAction.code, "RESET");
releaseStaleSleep();
const staleResult = await staleAction;
assert.equal(staleResult.code, "STALE_CALL", "a pre-reset async result must not be logged into fresh state");
assert.deepEqual(staleEngine.snapshot().jointState, homeJointState(model));
assert.deepEqual(staleEngine.snapshot().commandLog.map((entry) => entry.code), ["RESET"], "reset command history must not receive a ghost completion from the abandoned action");

let pauseEngine;
let pauseSleeps = 0;
pauseEngine = await ScenarioV2Engine.create(first, {
  sleep: async () => {
    pauseSleeps += 1;
    if (pauseSleeps === 1) await pauseEngine.call("robot.pause");
    else if (pauseSleeps === 2) await pauseEngine.call("robot.resume");
  }
});
const resumed = await pauseEngine.call("robot.send_action", { action: targetAction, durationMs: 320, sampleCount: 4 });
assert.equal(resumed.code, "ACTION_SENT");
assert.deepEqual(resumed.observation, targetAction);
assert.ok(pauseSleeps >= 2, "SO-101 joint command must actually pass through pause and resume");

const actionFields = { PAN: 1, LIFT: -80, ELBOW: 70, WRIST_FLEX: 50, WRIST_ROLL: 40, GRIPPER: 20, WAIT: 0.6 };
const fakeSendActionBlock = {
  type: "portable_so101_action",
  getFieldValue: (name) => actionFields[name],
  getNextBlock: () => null
};
const compiledBlockly = compileV2BlocklyProgram({ getTopBlocks: () => [fakeSendActionBlock] }, { robotId: "so101_follower" });
AUTHORIZED_ACTION_KEYS.forEach((key) => assert.match(compiledBlockly, new RegExp(`"${key.replace(".", "\\.")}"`)));
assert.match(compiledBlockly, /robot\.send_action/);
assert.match(compiledBlockly, /time\.sleep\(0\.6\)/);
assert.doesNotMatch(compiledBlockly, /async\s+def|await\s+/);
assert.match(compiledBlockly, /finally:\n    robot\.disconnect\(\)$/);

const pythonWorker = await readFile(resolve(ROOT, "js", "python-worker.js"), "utf8");
const compatibilityRuntime = await readFile(resolve(ROOT, "js", "python-compat-runtime.py"), "utf8");
assert.match(pythonWorker, /runPythonAsync/);
assert.match(compatibilityRuntime, /class SOFollower\(_Robot\):/);
assert.match(compatibilityRuntime, /def get_observation\(self\):/);
assert.match(compatibilityRuntime, /def send_action\(self, action, \*\*kwargs\):/);
assert.match(compatibilityRuntime, /namespace = \{"__name__": "__main__"/);
assert.doesNotMatch(compatibilityRuntime, /async\s+def/);
const workbenchSource = await readFile(resolve(ROOT, "lab", "js", "workbench-v2.js"), "utf8");
assert.match(workbenchSource, /Browser compatibility modules execute ordinary synchronous Python/);
assert.match(workbenchSource, /from lerobot\.robots\.so_follower import SO101Follower, SO101FollowerConfig/);
assert.match(workbenchSource, /robot = SO101Follower\(SO101FollowerConfig\(port=transport/);
assert.match(workbenchSource, /sent = robot\.send_action\(step/);
assert.match(workbenchSource, /observation = robot\.get_observation\(\)/);
const equipmentSceneSource = await readFile(resolve(ROOT, "lab", "v2", "equipment-scene.js"), "utf8");
assert.match(equipmentSceneSource, /transparent: !flushBaseMount/);
assert.match(equipmentSceneSource, /polygonOffset: flushBaseMount/);
for (const definition of definitions) {
  for (const requirement of definition.evidenceRequirements) {
    for (const allowed of requirement.allowedValues || []) assert.equal(workbenchSource.includes(allowed), false, `${definition.id}: starter source must not leak accepted evidence text`);
  }
  const generated = JSON.parse(await readFile(resolve(GENERATED, files.find((name) => name.startsWith(definition.id))), "utf8"));
  assert.equal(Object.hasOwn(generated, "validation"), false, `${definition.id}: browser client must omit answer-bearing validation executions`);
}

console.log("SO-101 physical-programmability correspondence passed:");
console.log("- pinned LeRobot six-field order, motor ids, units, and calibration boundary");
console.log("- official URDF limits and transformed baked-jaw geometry/collision correspondence");
console.log("- rest/environment clearance and explicit contact/place semantics across 10 tasks");
console.log("- deterministic full and partial send_action/get_observation, invalid rejection, pause/resume, STOP, and reset");
console.log("- Python and Blockly mappings with no starter evidence leakage");
