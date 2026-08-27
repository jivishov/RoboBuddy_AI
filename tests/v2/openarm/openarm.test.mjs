import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScenarioV2Engine,
  canonicalRendererData,
  collisionGeometry,
  compileV2BlocklyProgram,
  describePredicate,
  forwardKinematics,
  homeJointState,
  inverseKinematics,
  loadRobotModel,
  modelClaim,
  openArmWorkcellLayout,
  planJointPath,
  stateCollisionReport,
  stripValidationForClient,
  validateScenarioV2
} from "../../../lab/v2/index.js";
import { add3, dot3, normalize3, rotate3, rotationFromQuaternion, sub3, transformPoint } from "../../../lab/v2/math.js";
import { ROBOT_RIG_MESH_DATA as OPENARM_MESH_DATA } from "../../../simulator/js/robot-mesh-data-openarm-v2.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FAMILY = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "openarm");
const CLIENT_FAMILY = resolve(ROOT, "missions", "lab-assistant", "v2", "generated", "scenarios");
const files = (await readdir(FAMILY)).filter((name) => name.endsWith(".json")).sort();
assert.equal(files.length, 10, "OpenArm must author exactly ten v2 definitions");
const definitions = await Promise.all(files.map(async (name) => JSON.parse(await readFile(resolve(FAMILY, name), "utf8"))));
const clientDefinitions = await Promise.all(files.map(async (name) => JSON.parse(await readFile(resolve(CLIENT_FAMILY, name), "utf8"))));

const expectedIds = [
  "openarm-01-weighing-handoff",
  "openarm-02-glassware-handoff",
  "openarm-03-cuvette-handoff",
  "openarm-04-filtration-workcell",
  "openarm-05-titration-workcell",
  "openarm-06-cooling-handoff",
  "openarm-07-chromatography-workcell",
  "openarm-08-spectrometer-workcell",
  "openarm-09-standardization-workcell",
  "openarm-10-gravimetric-workcell"
];
const expectedSupersedes = [
  "openarm-01-weighing-handoff",
  "openarm-02-stabilized-solvent-addition",
  "openarm-03-stopper-and-mix",
  "openarm-04-pipette-loading",
  "openarm-05-filter-assembly",
  "openarm-06-controlled-pour",
  "openarm-07-buchner-station",
  "openarm-08-separatory-funnel",
  "openarm-09-titration-coordination",
  "openarm-10-gravimetric-workcell"
];
const expectedClasses = ["A", "C", "C", "C", "C", "C", "C", "C", "B", "B"];

assert.deepEqual(definitions.map((item) => item.id), expectedIds);
assert.deepEqual(definitions.map((item) => item.supersedes), expectedSupersedes);
assert.deepEqual(definitions.map((item) => item.rank), [1,2,3,4,5,6,7,8,9,10]);
assert.deepEqual(definitions.map((item) => item.migration.class), expectedClasses);

const model = await loadRobotModel("openarm_v2_bimanual");
const canonicalClaim = modelClaim("openarm_v2_bimanual");
assert.deepEqual(model.chains.left.endOffsetMm, [0,-168,0], "OpenArm planning must target the measured left fingertip contact height, not J7 or a mid-finger point");
assert.deepEqual(model.chains.right.endOffsetMm, [0,-168,0], "OpenArm planning must target the measured right fingertip contact height, not J7 or a mid-finger point");
const canonicalOpenArmMesh = await canonicalRendererData("openarm_v2_bimanual", OPENARM_MESH_DATA);

function decodedMeshVertices(meshKey) {
  const payload = OPENARM_MESH_DATA.meshes[meshKey];
  const bytes = Buffer.from(payload.positions, "base64");
  const quantization = Number(OPENARM_MESH_DATA.quantization) || 65535;
  return Array.from({ length: payload.vertexCount }, (_, vertex) => [0,1,2].map((axis) => {
    const ratio = bytes.readUInt16LE((vertex * 3 + axis) * 2) / quantization;
    return payload.bounds[axis] + (payload.bounds[axis + 3] - payload.bounds[axis]) * ratio;
  }));
}

function distalCurvedCentroid(meshKey) {
  const vertices = decodedMeshVertices(meshKey);
  const ys = vertices.map((point) => point[1]);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  const distal = vertices.filter((point) => point[1] <= minimumY + (maximumY - minimumY) * 0.12);
  assert.ok(distal.length > 100, `${meshKey}: distal named feature needs enough baked vertices`);
  return [0,1,2].map((axis) => distal.reduce((sum, point) => sum + point[axis], 0) / distal.length);
}

function partPoint(part, meshPoint) {
  const scalar = Number(part.scale) || 1;
  const scale = Array.isArray(part.scale3) ? part.scale3.map(Number) : [scalar, scalar, scalar];
  const scaled = meshPoint.map((value, axis) => value * scale[axis]);
  return add3((part.posMm || [0,0,0]).map(Number), rotate3(rotationFromQuaternion(part.quat), scaled));
}

function signedMeshVolume(meshKey) {
  const vertices = decodedMeshVertices(meshKey);
  let sixTimesVolume = 0;
  for (let index = 0; index < vertices.length; index += 3) {
    const [a, b, c] = [vertices[index], vertices[index + 1], vertices[index + 2]];
    sixTimesVolume += dot3(a, [
      b[1] * c[2] - b[2] * c[1],
      b[2] * c[0] - b[0] * c[2],
      b[0] * c[1] - b[1] * c[0]
    ]);
  }
  return sixTimesVolume / 6;
}

const rendererModel = {
  ...model,
  chains: { renderer: { id: "renderer", joints: model.rendererChain, endFrame: "right_finger_outer" } }
};
const closedGrippers = { ...homeJointState(model), left_gripper: 0, right_gripper: 0 };
const rendererFk = forwardKinematics(rendererModel, closedGrippers, { chainId: "renderer" });
const worldProxies = collisionGeometry(model, closedGrippers);
for (const side of ["left", "right"]) {
  const rawJ7 = OPENARM_MESH_DATA.chain.find((joint) => joint.id === `${side}_j7`);
  const rendererJ7 = model.rendererChain.find((joint) => joint.id === `${side}_j7`);
  const plannerJ7 = model.chains[side].joints.find((joint) => joint.id === `${side}_j7`);
  assert.deepEqual(rawJ7.baseQuat, [0,0,0,1], `${side}: unexpected baked J7 mount`);
  assert.deepEqual(rendererJ7.baseQuat, rawJ7.baseQuat, `${side}: renderer added a rigid J7 correction that cannot fix finger curvature`);
  assert.deepEqual(plannerJ7.baseQuat, rawJ7.baseQuat, `${side}: planner/render J7 frames diverged`);

  const fingerIds = [`${side}_finger_inner`, `${side}_finger_outer`];
  const hinges = fingerIds.map((id) => rendererFk.frames[id].position);
  const pinchCenter = hinges[0].map((value, axis) => (value + hinges[1][axis]) / 2);
  const spreadAxis = normalize3(sub3(hinges[0], hinges[1]));
  const distalWorld = fingerIds.map((id, index) => {
    const part = canonicalOpenArmMesh.parts.find((candidate) => candidate.group === id);
    assert.ok(part, `${id}: canonical renderer part missing`);
    const determinant = (part.scale3 || [part.scale, part.scale, part.scale]).reduce((product, value) => product * Number(value), 1);
    if (side === "right") {
      assert.ok(determinant > 0, `${id}: right finger correction inverted mesh normals`);
      assert.ok(signedMeshVolume(part.meshKey) > 0, `${id}: corrected right mesh has reversed baked winding`);
    }
    const worldPoint = transformPoint(rendererFk.frames[id], partPoint(part, distalCurvedCentroid(part.meshKey)));
    const hingeRadius = Math.abs(dot3(sub3(hinges[index], pinchCenter), spreadAxis));
    const distalRadius = Math.abs(dot3(sub3(worldPoint, pinchCenter), spreadAxis));
    assert.ok(distalRadius < hingeRadius - 8, `${id}: transformed distal geometry still curves away from the pinch gap (${distalRadius.toFixed(2)} >= ${hingeRadius.toFixed(2)})`);

    const proxy = worldProxies.find((candidate) => candidate.id === `render-openarm-${id}`);
    assert.ok(proxy && proxy.type === "box", `${id}: corrected finger collision proxy missing`);
    const proxyCoordinates = proxy.axes.map((axis) => dot3(sub3(worldPoint, proxy.centerMm), axis));
    proxyCoordinates.forEach((value, axis) => {
      assert.ok(Math.abs(value) <= proxy.halfExtentsMm[axis] + 0.01, `${id}: distal geometry escaped its corrected oriented collision proxy on local axis ${axis} (${value.toFixed(3)} vs +/- ${proxy.halfExtentsMm[axis].toFixed(3)})`);
    });
    return worldPoint;
  });
  const distalCenter = [0,1,2].map((axis) => (distalWorld[0][axis] + distalWorld[1][axis]) / 2);
  const socket = forwardKinematics(model, closedGrippers, { chainId: side }).positionMm;
  assert.ok(Math.abs(dot3(sub3(socket, distalCenter), spreadAxis)) < 1, `${side}: pinch socket left the corrected finger center plane`);
  assert.ok(Math.hypot(...sub3(socket, distalCenter)) < 12, `${side}: pinch socket no longer corresponds to the distal finger geometry`);
}

const blockFields = { OBJECT: "sample", APPROACH: "a", CONTACT: "c", LIFT: "l", DESTINATION: "d", PLACE: "p", RETREAT: "r", EFFECTOR: "left" };
const fakeTransportBlock = {
  type: "v2_transport",
  getFieldValue: (name) => blockFields[name],
  getNextBlock: () => null
};
const compiledTransport = compileV2BlocklyProgram({ getTopBlocks: () => [fakeTransportBlock] });
assert.match(compiledTransport, /place_frame="p"/);
assert.match(compiledTransport, /effector="left"/);
assert.doesNotMatch(compiledTransport, /seed=/);
blockFields.PLACE = "";
blockFields.EFFECTOR = "default";
const compiledLegacyDraft = compileV2BlocklyProgram({ getTopBlocks: () => [fakeTransportBlock] });
assert.doesNotMatch(compiledLegacyDraft, /place_frame=|effector=|seed=/);

const home = homeJointState(model);
const rightHome = Object.fromEntries(Object.keys(home).filter((id) => id.startsWith("right_")).map((id) => [id, home[id]]));
const fixedPath = planJointPath(model, home, { ...home, left_j1: home.left_j1 + 2 }, [], { chainId: "left", fixedJointState: home, maxStepDeg: 1 });
assert.equal(fixedPath.ok, true);
fixedPath.path.forEach((sample) => Object.entries(rightHome).forEach(([id, value]) => assert.equal(sample[id], value, `planner lost fixed ${id}`)));
const reachableTarget = forwardKinematics(model, home, { chainId: "left" }).positionMm;
const rejectedIk = inverseKinematics(model, reachableTarget, { chainId: "left", initialJointState: home, seed: 0, starts: 2, acceptJointState: () => false });
assert.equal(rejectedIk.code, "IK_GOAL_BLOCKED");
assert.ok(rejectedIk.diagnostics.convergedCount > 0);
assert.equal(rejectedIk.diagnostics.convergedCount, rejectedIk.diagnostics.rejectedCount);
const fixedSeedState = { ...home, base_yaw: 17, left_j5: 21, left_j7: -19 };
const fixedSeedTarget = forwardKinematics(model, fixedSeedState, { chainId: "left" }).positionMm;
const convergedFixedSeeds = [];
const fixedSeedIk = inverseKinematics(model, fixedSeedTarget, {
  chainId: "left",
  initialJointState: fixedSeedState,
  activeJoints: ["left_j1", "left_j2", "left_j3", "left_j4", "left_j6"],
  seed: 33,
  starts: 12,
  toleranceMm: 10,
  acceptJointState: (candidate) => { convergedFixedSeeds.push(candidate); return true; }
});
assert.equal(fixedSeedIk.ok, true);
assert.ok(convergedFixedSeeds.length > 1, "inactive-joint seed check needs more than the exact initial solution");
convergedFixedSeeds.forEach((candidate) => {
  assert.equal(candidate.base_yaw, fixedSeedState.base_yaw, "inactive base_yaw changed in a random IK seed");
  assert.equal(candidate.left_j5, fixedSeedState.left_j5, "inactive wrist roll changed in a random IK seed");
  assert.equal(candidate.left_j7, fixedSeedState.left_j7, "inactive wrist rotation changed in a random IK seed");
});

const sampleWorkcell = openArmWorkcellLayout({
  collisionProxies: [
    { id: "left-worktop", type: "box", centerMm: [375,308,-390], halfExtentsMm: [190,12,178] },
    { id: "right-worktop", type: "box", centerMm: [375,308,390], halfExtentsMm: [190,12,178] },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `leg-${index}`, type: "box", centerMm: [0,0,0], halfExtentsMm: [1,1,1] }))
  ]
});
assert.equal(sampleWorkcell.valid, true, "workcell must be two level worktops with eight structural legs");
assert.equal(sampleWorkcell.worktopTopY, 320);
assert.equal(describePredicate({ op: "not", predicate: { op: "frame_visited", frameId: "right_retreat" } }), "not (frame right_retreat must be visited)");

const continuityEngine = await ScenarioV2Engine.create(definitions[0]);
let continuityCursor = { ...continuityEngine.state.jointState };
for (const side of ["left", "right"]) {
  for (const suffix of ["approach", "contact", "lift", "handoff", "place_contact", "retreat"]) {
    const frameId = `${side}_${suffix}`;
    const planned = continuityEngine.planFrame(frameId, continuityCursor, { seed: 101, phase: frameId }, { ikSeed: 101, pathSeed: 43 });
    assert.equal(planned.ok, true, `${frameId}: continuity plan failed`);
    assert.match(planned.path.code, /^(BOUNDED_INTERPOLATION|RRT_CONNECT)$/, `${frameId}: continuity plan must remain collision checked`);
    assert.match(planned.attempts.at(-1).jointProfile, /^(stable|wrist|full)$/, `${frameId}: continuity plan used an unknown joint profile`);
    planned.path.path.forEach((sample) => {
      assert.equal(sample.base_yaw, continuityCursor.base_yaw, `${frameId}: simple motion rotated the shared base`);
      if (Object.hasOwn(sample, `${side}_gripper`)) assert.equal(sample[`${side}_gripper`], continuityCursor[`${side}_gripper`], `${frameId}: planner moved the gripper joint`);
    });
    const jointDistance = Math.hypot(...Object.keys(planned.path.path.at(-1)).map((jointId) => (
      Number(planned.path.path.at(-1)[jointId]) - Number(continuityCursor[jointId])
    )));
    // This generic position-only frame planner can redistribute shoulder and
    // elbow posture while keeping the shared base, wrist-roll joints, J7, and
    // gripper fixed. Keep that fallback bounded; the physical portable
    // reference below separately enforces dense <=10 mm Cartesian waypoints.
    assert.ok(jointDistance < 120, `${frameId}: continuity-first IK selected an unnecessarily remote posture (${jointDistance.toFixed(1)} degrees)`);
    continuityCursor = { ...continuityCursor, ...planned.path.path.at(-1) };
  }
}

function distance(a, b) {
  return Math.hypot(...a.map((value, index) => value - b[index]));
}

function matchingEventIndex(events, match, start = 0) {
  return events.findIndex((event, index) => index >= start && Object.entries(match).every(([key, value]) => event[key] === value));
}

function observationValue(definition) {
  const [left, right] = definition.objects;
  return `Observed ${left.id} at left_handoff and ${right.id} at right_handoff after fixture contact.`;
}

function assertContactCausality(definition, run) {
  const events = run.state.eventLog;
  const objectSequences = definition.objects.map((object, index) => {
    const side = index === 0 ? "left" : "right";
    const contact = matchingEventIndex(events, { type: "CONTACT", objectId: object.id, frameId: `${side}_contact` });
    const attach = matchingEventIndex(events, { type: "ATTACH_OBJECT", objectId: object.id, effector: side });
    const place = matchingEventIndex(events, { type: "PLACE_CONTACT", objectId: object.id, frameId: `${side}_place_contact` });
    const detach = matchingEventIndex(events, { type: "DETACH_OBJECT", objectId: object.id, frameId: `${side}_handoff` });
    assert.ok(contact >= 0, `${definition.id}: missing ${side} pickup contact`);
    assert.equal(attach, contact + 1, `${definition.id}: attachment must immediately follow matching contact`);
    assert.ok(place > attach, `${definition.id}: placement contact must follow attachment`);
    assert.equal(detach, place + 1, `${definition.id}: detachment must immediately follow placement contact`);
    return { contact, detach };
  });
  const ordered = objectSequences.slice().sort((a, b) => a.contact - b.contact);
  assert.ok(ordered[0].detach < ordered[1].contact, `${definition.id}: first object must detach before the other arm contacts its object`);

  const process = definition.processModels[0];
  const processContact = matchingEventIndex(events, { type: "PROCESS_CONTACT", processId: process.id });
  const processCommit = matchingEventIndex(events, { type: "PROCESS_COMMIT", processId: process.id, value: "confirmed" });
  assert.equal(processCommit, processContact + 1, `${definition.id}: process commit must immediately follow process contact`);
  assert.ok(processContact > Math.max(...objectSequences.map((item) => item.detach)), `${definition.id}: process contact must follow both detachments`);

  assert.equal(run.state.evidence.length, 1, `${definition.id}: validation supplies one post-gate learner observation`);
  const evidence = run.state.evidence[0];
  assert.equal(evidence.source, "learner-recorded");
  assert.ok(evidence.eventSequence >= events[processCommit].sequence, `${definition.id}: evidence must be recorded after process commit`);
  assert.equal(evidence.value, observationValue(definition));
}

async function executeObserved(definition, execution) {
  const fixture = definition.fixtures[0];
  const structuralObstacles = fixture.collisionProxies
    .filter((proxy) => String(proxy.id).includes("leg"))
    .map((proxy) => ({ id: `${fixture.id}:${proxy.id}`, ...proxy }));
  let sampleCount = 0;
  let previousBaseYaw = null;
  let previousJointState = null;
  let minimumEffectorSeparationMm = Infinity;
  const engine = await ScenarioV2Engine.create(definition, {
    onSample: (_sample, _index, state) => {
      sampleCount += 1;
      assert.deepEqual(state.rootPose.positionMm, [0,0,0], `${definition.id}: fixed root translated`);
      const baseYaw = Number(state.jointState.base_yaw);
      assert.equal(baseYaw, home.base_yaw, `${definition.id}: simple transport rotated the shared base`);
      for (const side of ["left", "right"]) {
        assert.equal(state.jointState[`${side}_j5`], home[`${side}_j5`], `${definition.id}: simple transport added ${side} wrist roll`);
        assert.equal(state.jointState[`${side}_j7`], home[`${side}_j7`], `${definition.id}: simple transport added ${side} wrist rotation`);
        assert.equal(state.jointState[`${side}_gripper`], home[`${side}_gripper`], `${definition.id}: planner moved the ${side} gripper joint`);
      }
      if (previousBaseYaw !== null) assert.ok(Math.abs(baseYaw - previousBaseYaw) <= 4.001, `${definition.id}: shared base_yaw path discontinuity`);
      previousBaseYaw = baseYaw;
      if (previousJointState) {
        Object.entries(state.jointState).forEach(([jointId, value]) => {
          assert.ok(Math.abs(Number(value) - Number(previousJointState[jointId])) <= 2.001, `${definition.id}: ${jointId} changed too abruptly`);
        });
      }
      previousJointState = { ...state.jointState };

      const fixtureCheck = stateCollisionReport(
        model,
        state.jointState,
        structuralObstacles,
        { basePose: state.rootPose }
      );
      assert.equal(fixtureCheck.ok, true, `${definition.id}: executed sample intersects a visible table leg`);

      const left = forwardKinematics(model, state.jointState, { chainId: "left", basePose: state.rootPose }).positionMm;
      const right = forwardKinematics(model, state.jointState, { chainId: "right", basePose: state.rootPose }).positionMm;
      minimumEffectorSeparationMm = Math.min(minimumEffectorSeparationMm, distance(left, right));
    }
  });
  assert.deepEqual(engine.snapshot().evidence, [], `${definition.id}: evidence must not be prefilled`);
  const run = await engine.executeProgram(execution.calls);
  assert.ok(sampleCount > 0, `${definition.id}: validation execution produced no trajectory samples`);
  assert.ok(
    minimumEffectorSeparationMm >= definition.coordination.minimumConfiguredEffectorSeparationMm,
    `${definition.id}: configured inter-effector clearance violated (${minimumEffectorSeparationMm.toFixed(1)} mm)`
  );
  return { engine, run, sampleCount, minimumEffectorSeparationMm };
}

let references = 0;
let alternates = 0;
let negatives = 0;
let observedSamples = 0;
let minimumObservedSeparationMm = Infinity;

for (const definition of definitions) {
  const supportedStackMission = definition.id === "openarm-04-filtration-workcell";
  const clientDefinition = clientDefinitions.find((item) => item.id === definition.id);
  const validation = validateScenarioV2(definition);
  assert.equal(validation.ok, true, `${definition.id}: ${JSON.stringify(validation.errors)}`);
  assert.equal(definition.schemaVersion, 2);
  assert.equal(definition.canonicalModelId, "openarm_v2_bimanual");
  assert.equal(definition.legacyClassification, definition.migration.class);
  if (definition.migration.class === "C") assert.ok(definition.migration.redesignRationale?.length > 40, `${definition.id}: class C rationale`);

  assert.equal(definition.coordination.rootTranslationAllowed, false);
  assert.equal(definition.coordination.sharedJointId, "base_yaw");
  assert.equal(definition.coordination.armScheduling, "sequential_shared_state_fixture_checked");
  assert.equal(definition.coordination.simultaneousPlansAllowed, false);
  assert.deepEqual(definition.coordination.acceptedSafeOrderings, ["left_then_right", "right_then_left"]);
  assert.equal(definition.coordination.minimumConfiguredEffectorSeparationMm, 300);
  assert.equal(definition.coordination.presentation?.objectAnchor, "authoritative_world_pose", `${definition.id}: renderer must consume the plant-owned object pose`);
  assert.equal(
    definition.coordination.presentation?.supportFoundation,
    supportedStackMission ? "floor_anchored_tables_with_visible_hotplate_and_ring_stand" : "floor_anchored_table",
    `${definition.id}: apparatus must resolve to its visible floor-anchored support foundation`,
  );

  assert.deepEqual(definition.modelClaim, canonicalClaim, `${definition.id}: exact canonical model claim`);
  assert.ok(definition.modelClaim.unsupportedPhysics.some((item) => item.includes("controller dynamics")));
  assert.ok(definition.modelClaim.unsupportedPhysics.some((item) => item.includes("ROS/DDS")));
  assert.ok(definition.modelClaim.unsupportedPhysics.some((item) => item.includes("payload")));
  assert.ok(!/(provides|supports|simulates)\s+(force|torque|payload|fluid|thermal|calibration|collision recovery)/i.test(JSON.stringify(definition)));

  assert.equal(definition.fixtures.every((fixture) => fixture.visible), true);
  const fixture = definition.fixtures[0];
  assert.equal(fixture.type, "configured_visible_bimanual_workcell");
  assert.deepEqual(fixture.collisionProxies.map((proxy) => proxy.id), [
    "left-worktop", "right-worktop",
    "left-leg-pickup-outer", "left-leg-pickup-inner", "left-leg-place-outer", "left-leg-place-inner",
    "right-leg-pickup-inner", "right-leg-pickup-outer", "right-leg-place-inner", "right-leg-place-outer"
  ]);
  assert.deepEqual(fixture.collisionProxies.slice(0, 2).map((proxy) => [proxy.centerMm, proxy.halfExtentsMm]), [
    [[375,308,-390], [190,12,178]],
    [[375,308,390], [190,12,178]]
  ]);
  assert.equal(fixture.collisionProxies.filter((proxy) => proxy.id.includes("leg")).length, 8);
  assert.doesNotMatch(JSON.stringify(fixture), /divider|tower|shelf|apron/i, `${definition.id}: rejected station structure leaked into the workcell`);
  assert.deepEqual(fixture.contactFrames, ["left_place_contact", "right_place_contact"]);
  const supportedFrames = new Set(definition.fixtures.map((item) => item.supportsFrame).filter(Boolean));
  assert.deepEqual([...supportedFrames], [], `${definition.id}: no synthetic per-object support fixtures may remain`);
  if (supportedStackMission) {
    assert.equal(definition.fixtures.length, 5, `${definition.id}: workcell, two physical support fixtures, and two presentation-only rulers are required`);
    assert.deepEqual(
      definition.fixtures.map((item) => item.type),
      ["configured_visible_bimanual_workcell", "configured_heater_platform", "configured_ring_stand_support", "configured_measurement_ruler", "configured_measurement_ruler"],
    );
    const physicalSupports = definition.fixtures.slice(1, 3).flatMap((item) => item.collisionProxies || [])
      .filter((proxy) => proxy.physicalSupportSurface);
    assert.deepEqual(physicalSupports.map((proxy) => [proxy.id, proxy.centerMm[1] + proxy.halfExtentsMm[1]]), [
      ["left-heater-top", 342],
      ["right-gauze-top", 388],
    ]);
    definition.fixtures.slice(3).forEach((rulerFixture) => {
      assert.equal(rulerFixture.presentationOnly, true);
      assert.equal(rulerFixture.measurement.axis, "y");
      assert.equal(rulerFixture.measurement.units, "mm");
    });
  } else {
    assert.equal(definition.fixtures.length, 1, `${definition.id}: only the real bimanual workcell fixture should remain`);
  }
  const workcellLayout = openArmWorkcellLayout({ collisionProxies: fixture.collisionProxies });
  assert.equal(workcellLayout.valid, true, `${definition.id}: real workcell structure is invalid`);
  assert.equal(workcellLayout.worktopTopY, 320);
  assert.match(definition.coordination.tableClearance.authority, /authoritative fixed-step plant/);
  assert.deepEqual(
    definition.coordination.tableClearance.forbiddenReachabilityAids,
    supportedStackMission
      ? ["transport trays", "proxy carriers", "registration pins", "synthetic reachability rods", "hidden supports", "tilted resting payloads"]
      : ["transport trays", "proxy carriers", "registration pins", "thin rods", "pedestals", "hidden supports", "tilted resting payloads"],
  );
  for (const side of ["left", "right"]) {
    const object = definition.objects.find((item) => (item.allowedEffectors || item.compatibleEffectors || []).includes(side));
    const gripHeight = Number(object.physicalRest.gripSocketMm[1]);
    assert.ok(Math.abs(definition.frames[`${side}_contact`].positionMm[1] - workcellLayout.worktopTopY - gripHeight) < 1e-6, `${definition.id}: ${side} pickup must target the direct apparatus grip socket`);
    const finalPose = Object.entries(object.physicalRest.poses).find(([frameId]) => frameId !== object.initialFrame)?.[1];
    const destinationSurface = definition.fixtures.flatMap((item) => item.collisionProxies || [])
      .find((proxy) => proxy.id === finalPose?.surfaceId);
    assert.ok(destinationSurface?.physicalSupportSurface, `${definition.id}: ${side} destination must resolve to a real support surface`);
    const destinationTopY = Number(destinationSurface.centerMm[1]) + Number(destinationSurface.halfExtentsMm[1]);
    assert.ok(Math.abs(definition.frames[`${side}_place_contact`].positionMm[1] - destinationTopY - gripHeight) <= 3, `${definition.id}: ${side} placement must target the supported apparatus grip socket within the physical release tolerance`);
  }
  definition.objects.forEach((object) => {
    assert.equal(object.visual.directHandling, true);
    assert.equal(object.visual.containerFree, true);
    assert.notEqual(object.visual.type, "apparatus_transport");
    assert.notEqual(object.visual.type, "secured_carrier");
    assert.equal(object.visual.gripSocketMm.length, 3);
    assert.equal(object.visual.footprintMm.length, 2);
    assert.ok(object.visual.footprintMm.every((value) => Number(value) > 0));
    assert.equal(object.physicalRest.localUp[1], 1);
    Object.values(object.physicalRest.poses).forEach((pose) => {
      const surface = definition.fixtures.flatMap((item) => item.collisionProxies || []).find((proxy) => proxy.id === pose.surfaceId);
      assert.ok(surface?.physicalSupportSurface, `${definition.id}/${object.id}: ${pose.surfaceId} must be a declared physical support surface`);
    });
  });
  const homeFixtureObstacles = definition.fixtures.flatMap((item) => (item.collisionProxies || [])
    .map((proxy) => ({ id: `${item.id}:${proxy.id}`, ...proxy })));
  const homeFixtureCheck = stateCollisionReport(
    model,
    home,
    homeFixtureObstacles,
    { basePose: { positionMm: [0,0,0], rotationDeg: [0,0,0] } }
  );
  assert.equal(homeFixtureCheck.ok, true, `${definition.id}: visible workcell intersects the robot at rest`);

  assert.equal(definition.objects.every((object) => object.visible && object.visual?.type), true);
  assert.equal(
    definition.objects.every((object) => supportedStackMission
      ? object.initialState?.contentsSimulation === "empty; no liquid modeled"
      : object.initialState?.contentsSimulation === "not modeled"),
    true,
  );
  assert.equal(definition.grasps.length, 2);
  assert.equal(definition.grasps[0].effector, "left");
  assert.equal(definition.grasps[1].effector, "right");

  const process = definition.processModels[0];
  assert.equal(process.discrete && process.contactGated, true);
  assert.equal(process.prerequisites.length, supportedStackMission ? 14 : 12, `${definition.id}: process needs state, contact, attach, place, detach, retreat, and any source-owned support measurements`);

  for (const side of ["left","right"]) {
    for (const suffix of ["approach","contact","lift","handoff","place_contact","retreat"]) {
      const frame = definition.frames[`${side}_${suffix}`];
      assert.ok(frame, `${definition.id}: missing ${side}_${suffix}`);
      assert.equal(frame.chainId, side);
    }
    const approach = definition.frames[`${side}_approach`].positionMm;
    const contact = definition.frames[`${side}_contact`].positionMm;
    const lift = definition.frames[`${side}_lift`].positionMm;
    const handoff = definition.frames[`${side}_handoff`].positionMm;
    const placeContact = definition.frames[`${side}_place_contact`].positionMm;
    const retreat = definition.frames[`${side}_retreat`].positionMm;
    const object = definition.objects.find((item) => (item.allowedEffectors || item.compatibleEffectors || []).includes(side));
    const expectedApproachClearance = object.visual.type === "watch_glass" ? 120 : 180;
    assert.deepEqual([approach[0], approach[2]], [contact[0], contact[2]], `${definition.id}: pickup approach must be vertical`);
    assert.equal(approach[1] - contact[1], expectedApproachClearance, `${definition.id}: pickup approach clearance changed`);
    assert.deepEqual([lift[0], lift[2]], [contact[0], contact[2]], `${definition.id}: lift must reverse the vertical pickup descent`);
    assert.equal(lift[1] - contact[1], 120, `${definition.id}: carried lift clearance changed`);
    assert.equal(handoff[1], lift[1], `${definition.id}: short transfer must stay at lift clearance`);
    const transferDistance = Math.hypot(handoff[0] - contact[0], handoff[2] - contact[2]);
    assert.ok(transferDistance >= 90 && transferDistance <= 130, `${definition.id}: transfer distance must remain short and direct`);
    assert.ok(Math.hypot(placeContact[0] - handoff[0], placeContact[2] - handoff[2]) <= 5, `${definition.id}: calibrated placement must descend nearly vertically from transfer clearance`);
    const finalPose = Object.entries(object.physicalRest.poses).find(([frameId]) => frameId !== object.initialFrame)?.[1];
    const destinationSurface = definition.fixtures.flatMap((item) => item.collisionProxies || [])
      .find((proxy) => proxy.id === finalPose?.surfaceId);
    const destinationTopY = Number(destinationSurface.centerMm[1]) + Number(destinationSurface.halfExtentsMm[1]);
    const expectedPlacementDescent = 120 - (destinationTopY - workcellLayout.worktopTopY);
    assert.ok(Math.abs(handoff[1] - placeContact[1] - expectedPlacementDescent) <= 3, `${definition.id}: placement descent must preserve the 120 mm carried clearance relative to the real destination support`);
    assert.equal(definition.frames[`${side}_place_contact`].coincidentWith, undefined, `${definition.id}: distinct transfer and place frames collapsed`);
    if (supportedStackMission) {
      assert.equal(retreat[0], handoff[0], `${definition.id}: ${side} retreat stays above the support centerline`);
      assert.equal(retreat[2], handoff[2], `${definition.id}: ${side} retreat rises vertically clear of the released vessel`);
      assert.equal(retreat[1] - handoff[1], 25, `${definition.id}: ${side} retreat must finish 25 mm above the carried-clearance frame`);
    } else {
      assert.deepEqual(retreat, handoff, `${definition.id}: retreat must reverse the vertical placement descent`);
    }
    assert.equal(definition.frames[`${side}_retreat`].coincidentWith, undefined, `${definition.id}: retreat must not masquerade as home`);
  }
  for (const suffix of ["approach","contact","lift","handoff","place_contact","retreat"]) {
    assert.ok(distance(definition.frames[`left_${suffix}`].positionMm, definition.frames[`right_${suffix}`].positionMm) > 300, `${definition.id}: left/right ${suffix} frames collapsed`);
  }

  assert.deepEqual(definition.evidenceRequirements, []);
  assert.ok(definition.hiddenGradingRequirements.length > 0);
  assert.ok(clientDefinition, `${definition.id}: generated client scenario missing`);
  assert.equal(Object.hasOwn(clientDefinition.api, "starterCalls"), false, `${definition.id}: symbolic starter calls removed`);
  assert.deepEqual(clientDefinition, stripValidationForClient(definition), `${definition.id}: generated client output drifted from its owning source transform`);

  const engine = await ScenarioV2Engine.create(definition, { autoStartPlant: false });
  assert.equal((await engine.call("compat.connect", { instanceId: "openarm-family", config: { kind: "bimanual", side: "bimanual", cameras: {} } })).ok, true);
  let scenarioMinimumSeparation = Infinity;
  let scenarioSamples = 0;
  const specialJointMotion = {
    j5: { maxAbs: 0, maxStep: 0 },
    j7: { maxAbs: 0, maxStep: 0 },
  };
  let previousAction = null;
  for (const step of definition.portablePython.referenceActions) {
    assert.equal(Object.hasOwn(step.action, "base_yaw"), false, `${definition.id}/${step.label}: simulator stand yaw must not leak into public actions`);
    if (previousAction) {
      for (const side of ["left", "right"]) for (const joint of [5, 7]) {
        const key = `${side}_joint_${joint}.pos`;
        const value = Number(step.action[key]);
        const prior = Number(previousAction[key]);
        specialJointMotion[`j${joint}`].maxAbs = Math.max(specialJointMotion[`j${joint}`].maxAbs, Math.abs(value));
        specialJointMotion[`j${joint}`].maxStep = Math.max(specialJointMotion[`j${joint}`].maxStep, Math.abs(value - prior));
      }
    }
    previousAction = step.action;
    const sent = await engine.call("compat.send_action", { instanceId: "openarm-family", action: step.action, options: {} });
    assert.equal(sent.ok, true, `${definition.id}/${step.label}: public action`);
    for (let tick = 0; tick < Math.ceil(step.hold_seconds / engine.plant.tickSeconds); tick += 1) {
      engine.plant.tick();
      const state = engine.snapshot();
      const left = forwardKinematics(model, state.jointState, { chainId: "left", basePose: state.rootPose }).positionMm;
      const right = forwardKinematics(model, state.jointState, { chainId: "right", basePose: state.rootPose }).positionMm;
      scenarioMinimumSeparation = Math.min(scenarioMinimumSeparation, distance(left, right));
      scenarioSamples += 1;
    }
    assert.equal(engine.plant.fault, null, `${definition.id}/${step.label}: collision-clear plant motion`);
  }
  await engine.call("compat.disconnect", { instanceId: "openarm-family" });
  const state = engine.snapshot();
  assert.equal(state.grade.passed, true, `${definition.id}: authoritative portable grade`);
  assert.deepEqual(state.rootPose.positionMm, [0, 0, 0]);
  assert.equal(state.jointState.base_yaw, home.base_yaw, `${definition.id}: base_yaw remained still`);
  for (const side of ["left", "right"]) {
    const contacts = state.eventLog.filter((event) => event.type === "CONTACT" && event.effector === side);
    const attachments = state.eventLog.filter((event) => event.type === "ATTACH_OBJECT" && event.effector === side);
    assert.ok(contacts.length > 0 && attachments.length > 0, `${definition.id}: ${side} FK contact and attachment`);
  }
  assert.ok(scenarioMinimumSeparation >= definition.coordination.minimumConfiguredEffectorSeparationMm);
  const tangentialWatchPinch = definition.objects.some((object) => object.visual.type === "watch_glass");
  assert.ok(specialJointMotion.j5.maxAbs <= (tangentialWatchPinch ? 79 : 63), `${definition.id}: J5 exceeded the bounded level-payload orientation envelope`);
  assert.ok(specialJointMotion.j7.maxAbs <= (tangentialWatchPinch ? 69 : 17), `${definition.id}: J7 exceeded the bounded direct-grasp orientation envelope`);
  assert.ok(specialJointMotion.j5.maxStep <= 35, `${definition.id}: J5 action discontinuity`);
  assert.ok(specialJointMotion.j7.maxStep <= 25, `${definition.id}: J7 action discontinuity`);
  observedSamples += scenarioSamples;
  minimumObservedSeparationMm = Math.min(minimumObservedSeparationMm, scenarioMinimumSeparation);
  references += 1;

  for (const execution of definition.validation.acceptedAlternates) {
    assert.equal(execution.calls, undefined);
    assert.equal(execution.portableProgram.learnerGradingCalls, false);
    alternates += 1;
  }
  for (const execution of definition.validation.negativeCases) {
    assert.equal(execution.calls, undefined);
    assert.equal(execution.portableNegative, true);
    negatives += 1;
  }
}

// A learner can still command an unsafe direct target. Both sides must stop at
// the last valid authoritative sample without inventing contact or attachment.
const unsafeCollisionSummaries = [];
for (const side of ["left", "right"]) {
  const definition = definitions[0];
  const engine = await ScenarioV2Engine.create(definition, { autoStartPlant: false });
  assert.equal((await engine.call("compat.connect", { instanceId: `unsafe-${side}`, config: { kind: "bimanual", side: "bimanual", cameras: {} } })).ok, true);
  const contact = definition.portablePython.referenceActions.find((step) => step.label === `${side} contact approach`);
  assert.ok(contact, `${side}: reference contact target unavailable`);
  const initial = { ...home };
  for (let index = 1; index <= 7; index += 1) initial[`${side}_j${index}`] = contact.action[`${side}_joint_${index}.pos`];
  const belowWorktop = inverseKinematics(model, [310, 285, side === "left" ? -340 : 340], {
    chainId: side,
    initialJointState: initial,
    activeJoints: [1, 2, 3, 4, 5, 6, 7].map((index) => `${side}_j${index}`),
    seed: side === "left" ? 901 : 902,
    starts: 48,
    maxIterations: 700,
    toleranceMm: 8
  });
  assert.equal(belowWorktop.ok, true, `${side}: deliberately below-worktop target must be reachable before collision enforcement`);
  const directAction = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((index) => [
    `${side}_joint_${index}.pos`, belowWorktop.jointState[`${side}_j${index}`]
  ]));
  directAction[`${side}_gripper.pos`] = -65;
  directAction[`${side}_joint_1.pos`] += side === "left" ? 20 : -60;
  assert.equal((await engine.call("compat.send_action", { instanceId: `unsafe-${side}`, action: directAction, options: {} })).ok, true);
  for (let tick = 0; tick < 300 && !engine.plant.fault; tick += 1) engine.plant.tick();
  assert.equal(engine.plant.fault?.code, "SIMULATOR_COLLISION_FAULT", `${side}: unsafe direct table path must fault`);
  assert.match(engine.plant.fault?.collision?.robotProxyId || "", new RegExp(side), `${side}: the independently commanded gripper must own the collision`);
  assert.match(engine.plant.fault?.collision?.obstacleId || "", /worktop|support/, `${side}: fault must name visible table or staging support geometry`);
  unsafeCollisionSummaries.push(`${side} ${engine.plant.fault.collision.robotProxyId} -> ${engine.plant.fault.collision.obstacleId}`);
  const retained = engine.snapshot();
  for (let tick = 0; tick < 10; tick += 1) engine.plant.tick();
  assert.deepEqual(engine.snapshot().jointState, retained.jointState, `${side}: collision fault must retain the last valid state`);
  assert.equal(retained.eventLog.some((event) => ["CONTACT", "ATTACH_OBJECT", "PLACE_CONTACT", "DETACH_OBJECT"].includes(event.type)), false, `${side}: unsafe motion cannot fabricate grasp or placement events`);
  const disconnected = await engine.call("compat.disconnect", { instanceId: `unsafe-${side}` });
  assert.equal(disconnected.state.feedback.code, "SIMULATOR_COLLISION_FAULT", `${side}: cleanup disconnect must not overwrite the authoritative collision fault`);
  assert.equal(disconnected.state.runState, "fault", `${side}: cleanup disconnect must not make the stage ready`);
  engine.dispose();
}

assert.equal(references, 10);
assert.equal(alternates, 10);
assert.equal(negatives, 30);
assert.ok(observedSamples >= references + alternates, "Every positive execution must receive focused geometry checks");
assert.ok(minimumObservedSeparationMm >= 300);

console.log("OpenArm v2 critical family checks passed:");
console.log("- decoded baked finger vertices form inward left/right cradles with preserved right-hand winding, pinch sockets, and collision boxes");
console.log("- 10 one-to-one successors, corrected migration classes, exact canonical claims, and explicit visual approximations");
console.log("- portable FK contact/attachment, hidden grading, fixed-root, fixture-proxy, and coarse inter-effector checks passed");
console.log("- both grippers retain table-clear approach, grasp, carry, release, and retreat paths; direct unsafe targets fault at the last valid sample");
console.log(`- unsafe collision witnesses: ${unsafeCollisionSummaries.join("; ")}`);
console.log("- 10 references executed; 10 alternates retain portable metadata without symbolic learner calls");
console.log(`- ${observedSamples} executed trajectory samples checked; minimum configured inter-effector separation ${minimumObservedSeparationMm.toFixed(1)} mm`);
console.log("- 30 negative records retain portable-negative metadata without learner grading calls");
