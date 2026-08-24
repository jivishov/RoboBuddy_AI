import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScenarioV2Engine,
  SO101_COMMAND_MODEL,
  homeJointState,
  inverseKinematics,
  loadRobotModel,
  methodAvailable,
  modelClaim,
  validateProxyEnclosure,
  validateScenarioV2
} from "../../../lab/v2/index.js";
import { validateRestPose } from "../../../lab/v2/physical-rest.js";
import { radialSurfaceRadiusAtHeight } from "../../../lab/v2/apparatus-geometry.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFINITIONS = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "so101");
const V1 = resolve(ROOT, "missions", "lab-assistant", "v1");
const EXPECTED_SUPERSEDES = [
  "so101-01-weigh-boat",
  "so101-02-mixing-station",
  "so101-03-cuvette-orientation",
  "so101-04-filter-assembly",
  "so101-05-pipette-pump",
  "so101-06-quantitative-transfer",
  "so101-07-chromatography-spotting",
  "so101-08-burette-initial-reading",
  "so101-09-vacuum-filtration",
  "so101-10-endpoint-assistant"
];
const EXPECTED_CLASSES = ["B", "B", "C", "B", "B", "C", "C", "C", "C", "C"];

function distance(a, b) {
  return Math.hypot(...a.map((value, index) => Number(value) - Number(b[index])));
}

function fixtureTopY(fixture) {
  const proxies = fixture.collisionProxies || [fixture.collisionProxy];
  return Math.max(...proxies.map((proxy) => Number(proxy.centerMm[1]) + Number(proxy.halfExtentsMm[1])));
}

function callsBeforeEvidence(execution) {
  return execution.calls.slice(0, execution.calls.findIndex((call) => call.method === "lab.record_evidence"));
}

const USER_FACING_KEYS = new Set([
  "title", "label", "brief", "description", "semantic", "claim",
  "instruction", "message", "redesignRationale", "contents",
  "approximation", "provenance", "roleRedesign", "releaseRequirement",
  "legacyLearningObjective",
]);
function userFacingStrings(value, output = []) {
  if (Array.isArray(value)) value.forEach((item) => userFacingStrings(item, output));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && USER_FACING_KEYS.has(key)) output.push(child);
      else if (child && typeof child === "object") userFacingStrings(child, output);
    }
  }
  return output;
}

const files = (await readdir(DEFINITIONS)).filter((name) => name.endsWith(".json")).sort();
assert.equal(files.length, 10, "SO-101 must author exactly ten definitions");
const definitions = await Promise.all(files.map(async (file) => JSON.parse(await readFile(resolve(DEFINITIONS, file), "utf8"))));
assert.deepEqual(definitions.map((item) => item.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.deepEqual(definitions.map((item) => item.supersedes), EXPECTED_SUPERSEDES);
assert.deepEqual(definitions.map((item) => item.migration.class), EXPECTED_CLASSES);

const model = await loadRobotModel("so101_follower");
const canonicalClaim = modelClaim("so101_follower");
const home = homeJointState(model);
assert.equal(validateProxyEnclosure(model, home).ok, true);

let references = 0;
let alternates = 0;
let negatives = 0;
let reachableFrames = 0;
for (const definition of definitions) {
  const legacy = JSON.parse(await readFile(resolve(V1, `${definition.supersedes}.json`), "utf8"));
  const validation = validateScenarioV2(definition, { expectedRobotId: "so101_follower" });
  assert.equal(validation.ok, true, `${definition.id}:\n${validation.errors.map((item) => `${item.path}: ${item.message}`).join("\n")}`);
  assert.equal(definition.schemaVersion, 2);
  assert.equal(definition.legacyClassification, definition.migration.class);
  if (definition.migration.class === "C") assert.ok(/unsupported|cannot be validated|outside|exceed/i.test(definition.migration.redesignRationale), `${definition.id}: explicit unsupported-action redesign`);
  assert.equal(definition.rank, legacy.rank, `${definition.id}: legacy rank`);
  assert.equal(definition.robotId, legacy.robotId, `${definition.id}: legacy robot`);
  assert.equal(definition.assistanceLevel, legacy.assistanceLevel, `${definition.id}: legacy assistance level`);
  assert.equal(definition.canonicalModel.sourceRevision, model.source.revision);
  assert.deepEqual(definition.modelClaim, canonicalClaim);
  assert.equal(definition.navigation.fixedBase, true);
  assert.equal(definition.fixtures.length, definition.objects.length * 2 + 1, `${definition.id}: mount plus pickup and destination fixtures`);
  assert.ok(definition.fixtures.every((fixture) => fixture.visible === true && fixture.configured === true));
  assert.ok(definition.fixtures.every((fixture) => (
    fixture.collisionProxy?.type === "box"
    || fixture.collisionProxies?.every((proxy) => proxy.type === "box")
  )));
  const mount = definition.fixtures.find((fixture) => fixture.id === "so101_base_mount");
  assert.equal(mount?.collisionProxy?.planningRole, "robot_mount_contact", `${definition.id}: only the narrow fixed-base mounting contact is exempted`);
  assert.equal(mount.collisionProxy.centerMm[1] + mount.collisionProxy.halfExtentsMm[1], 0, `${definition.id}: visible mounting plate top aligns to robot root plane`);
  assert.ok(definition.grasps.every((grasp) => (
    grasp.mode === "direct-apparatus"
      && grasp.visible === true
      && grasp.allowedRobotContactBodies?.includes("gripper_link__wrist_roll_follower_so101_v1_stl_1")
      && grasp.allowedRobotContactBodies?.includes("moving_jaw_so101_v1_link__moving_jaw_so101_v1_stl_0")
      && grasp.physicalContact?.schema === "robobuddy.opposed-pinch.v1"
      && grasp.physicalContact?.fixedFaceSign === 1
      && grasp.physicalContact?.movingFaceSign === -1
      && grasp.physicalContact?.maxPenetrationMm <= 1
      && grasp.physicalContact?.contactHalfExtentMm > 0
      && Math.abs(grasp.physicalContact?.capturedThicknessMm - grasp.physicalContact?.contactHalfExtentMm * 2) <= 0.5
      && grasp.physicalContact?.capturedThicknessMm > 0
  )), `${definition.id}: only the two rendered SO-101 finger bodies may contact directly handled apparatus`);
  for (const grasp of definition.grasps) {
    const object = definition.objects.find((item) => item.id === grasp.objectId);
    const profile = object?.physicalRest?.geometry?.radialProfileMm;
    if (!profile) continue;
    const rendererRadiusMm = radialSurfaceRadiusAtHeight(profile, grasp.physicalContact.bandCenterLocalMm[1]);
    assert.ok(Math.abs(rendererRadiusMm - grasp.physicalContact.contactHalfExtentMm) <= 0.5, `${definition.id}/${object.id}: physical pinch width matches the shared rendered radial profile`);
  }
  assert.ok(Object.values(definition.frames).every((frame) => !Object.hasOwn(frame, "joints") && !Object.hasOwn(frame, "jointState")), `${definition.id} must not expose target joint tuples`);
  assert.ok(new Set(Object.values(definition.frames).map((frame) => JSON.stringify(frame.positionMm))).size >= definition.objects.length * 4, `${definition.id}: contact, clearance, transfer, and place poses remain spatially distinct`);
  assert.ok(definition.evidenceRequirements.every((item) => item.availableWhen && item.requiresEvent));
  assert.ok(definition.evidenceRequirements.every((item) => item.allowedValues?.length === 1));
  assert.equal(Object.hasOwn(definition, "starters"), false, `${definition.id}: no prefilled evidence starter`);
  assert.ok(definition.modelClaim.unsupportedPhysics.some((item) => item.includes("cameras/sensing")));
  assert.ok(definition.modelClaim.unsupportedPhysics.some((item) => item.includes("payload")));
  assert.doesNotMatch(
    userFacingStrings(definition).join("\n"),
    /\b(?:carrier|adapter|destination slot|queue cassette|weigh boat|volumetric flask|sample cuvette)\b/i,
    `${definition.id}: visible copy names directly handled apparatus and real work surfaces`,
  );
  assert.doesNotMatch(
    JSON.stringify({ objects: definition.objects, frames: definition.frames, fixtures: definition.fixtures, grasps: definition.grasps, goalPredicates: definition.goalPredicates }),
    /\b(?:weigh_boat|volumetric_flask|sample_cuvette|filter_paper_carrier|sealed_aliquot_carrier|capped_spotting_tool|capped_burette_carrier|funnel_carrier|sealed_buchner_carrier|sealed_filter_carrier)\b/,
    `${definition.id}: obsolete substituted-equipment identifiers do not drive the live plant`,
  );

  for (const object of definition.objects) {
    const names = {
      approach: `${object.id}_approach`,
      contact: `${object.id}_contact`,
      lift: `${object.id}_lift`,
      destination: `${object.id}_destination`,
      place: `${object.id}_place_contact`,
      retreat: `${object.id}_retreat`
    };
    for (const [role, frameId] of Object.entries(names)) {
      assert.equal(definition.frames[frameId]?.role, role === "place" ? "contact" : role, `${definition.id}/${object.id}: ${role} frame`);
      const ik = inverseKinematics(model, definition.frames[frameId].positionMm, {
        initialJointState: home,
        seed: 313,
        starts: 16,
        toleranceMm: definition.frames[frameId].tolerance.positionMm
      });
      assert.equal(ik.ok, true, `${definition.id}/${frameId}: independently reachable (${ik.errorMm.toFixed(2)} mm)`);
      reachableFrames += 1;
    }
    assert.ok(definition.frames[names.approach].positionMm[1] - definition.frames[names.contact].positionMm[1] >= 80, `${definition.id}/${object.id}: approach clearance`);
    assert.ok(definition.frames[names.lift].positionMm[1] - definition.frames[names.contact].positionMm[1] >= 80, `${definition.id}/${object.id}: lift clearance`);
    assert.ok(definition.frames[names.retreat].positionMm[1] - definition.frames[names.place].positionMm[1] >= 80, `${definition.id}/${object.id}: retreat clearance`);
    assert.ok(distance(definition.frames[names.contact].positionMm, definition.frames[names.destination].positionMm) >= 300, `${definition.id}/${object.id}: source and destination separation`);
    assert.equal(definition.frames[names.place].coincidentWith, names.destination, `${definition.id}/${object.id}: semantic destination names its physical place contact`);
    const carriedBottomClearanceMm = definition.frames[names.destination].positionMm[1] - Number(object.physicalRest.gripSocketMm[1]);
    const otherApparatusHeightMm = Math.max(0, ...definition.objects
      .filter((other) => other.id !== object.id)
      .map((other) => Number(other.physicalRest.geometry.halfExtentsMm[1]) * 2));
    assert.ok(
      carriedBottomClearanceMm >= Math.max(100, otherApparatusHeightMm + 12),
      `${definition.id}/${object.id}: carried bottom clears the worktop and every other resting apparatus`
    );
    assert.equal(Object.hasOwn(definition.frames[names.approach], "contactFixtureId"), false, `${definition.id}/${object.id}: approach retains structural fixture collisions`);
    assert.equal(Object.hasOwn(definition.frames[names.lift], "contactFixtureId"), false, `${definition.id}/${object.id}: lift uses contact-aware departure rather than disabling the fixture`);
    assert.equal(Object.hasOwn(definition.frames[names.retreat], "contactFixtureId"), false, `${definition.id}/${object.id}: retreat uses contact-aware departure rather than disabling the fixture`);
    const pickup = definition.fixtures.find((fixture) => fixture.id === `${object.id}_pickup_adapter`);
    const destination = definition.fixtures.find((fixture) => fixture.id === `${object.id}_destination_slot`);
    assert.equal(object.initialFrame, names.contact);
    assert.equal(definition.grasps.find((grasp) => grasp.objectId === object.id)?.fixtureId, pickup.id);
    assert.equal(pickup.type, "configured_real_work_surface");
    assert.equal(destination.type, "configured_real_work_surface");
    const renderedGripY = Number(object.visual.gripSocketMm?.[1]) * Number(object.visual.scale || 1);
    assert.ok(Math.abs(definition.frames[names.contact].positionMm[1] - renderedGripY - fixtureTopY(pickup)) <= 0.001, `${definition.id}/${object.id}: rendered bottom meets pickup support`);
    assert.ok(Math.abs(definition.frames[names.place].positionMm[1] - renderedGripY - fixtureTopY(destination)) <= 0.001, `${definition.id}/${object.id}: rendered bottom meets placement support`);
    assert.equal(destination.atFrame, names.place, `${definition.id}/${object.id}: visible receiving fixture owns the placement-contact frame`);
    assert.equal(object.visual.directHandling, true, `${definition.id}/${object.id}: rendered as direct apparatus`);
    assert.equal(object.visual.containerFree, true, `${definition.id}/${object.id}: no handling container`);
    assert.equal(object.physicalRest.directHandling, true, `${definition.id}/${object.id}: physical proxy belongs to the apparatus`);
    assert.equal(object.physicalRest.containerFree, true, `${definition.id}/${object.id}: physical rest is container-free`);
    assert.notEqual(object.visual.type, "apparatus_transport", `${definition.id}/${object.id}: no generic box transport renderer`);
    assert.notEqual(object.visual.type, "secured_carrier", `${definition.id}/${object.id}: no secured-carrier renderer`);
    assert.notEqual(object.attachmentInterface, "secured_carrier_mount", `${definition.id}/${object.id}: no carrier attachment`);
    assert.doesNotMatch(object.physicalRest.supportKind, /stick|post|pin|tab|pedestal|rod/i, `${definition.id}/${object.id}: no invented support kind`);
  }

  assert.equal(definition.portablePython.claim, "API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending.");
  assert.deepEqual(definition.portablePython.officialPython, {
    importPath: "lerobot.robots.so_follower",
    robotClass: "SO101Follower",
    configClass: "SO101FollowerConfig",
    actionMethod: "send_action",
    observationMethod: "get_observation",
    synchronous: true,
    sourceRevision: SO101_COMMAND_MODEL.sources.lerobot.revision,
    browserBoundary: "API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending."
  });
  assert.match(definition.api.physicalProgrammability.learnerProgramContract, /lerobot\.robots\.so_follower.*send_action/);
  assert.doesNotMatch(JSON.stringify(definition.api.physicalProgrammability), /skills\.transport/);

  for (const process of definition.processModels) {
    assert.equal(process.discrete, true);
    assert.equal(process.contactGated, true);
    assert.ok(definition.frames[process.contactFrame], `${definition.id}/${process.id}: process contact frame`);
    assert.ok(definition.fixtures.some((fixture) => fixture.id === process.fixtureId), `${definition.id}/${process.id}: process fixture`);
    assert.deepEqual(new Set(process.prerequisites.map((item) => item.objectId)), new Set(definition.objects.slice(0, -1).map((item) => item.id)));
    definition.objects.slice(0, -1).forEach((object) => {
      assert.ok(process.prerequisites.some((item) => item.op === "object_at" && item.objectId === object.id && item.frameId === `${object.id}_destination`), `${definition.id}/${process.id}: prior placement prerequisite for ${object.id}`);
    });
  }
  if (definition.objects.length === 1) {
    assert.equal(definition.processModels.length, 0, `${definition.id}: single-object placement needs no redundant readiness process`);
  } else {
    const destinationIds = definition.objects.map((object) => `${object.id}_destination`);
    assert.equal(new Set(destinationIds.map((id) => JSON.stringify(definition.frames[id].positionMm))).size, destinationIds.length, `${definition.id}: multi-object destination slots are distinct`);
    definition.objects.forEach((object, index) => {
      definition.objects.slice(index + 1).forEach((other) => {
        assert.ok(distance(definition.frames[`${object.id}_destination`].positionMm, definition.frames[`${other.id}_destination`].positionMm) >= 100, `${definition.id}: destination slots do not overlap`);
      });
    });
  }

  const premature = await ScenarioV2Engine.create(definition);
  const prematureResponse = await premature.call("lab.record_evidence", {
    requirementId: definition.hiddenGradingRequirements[0].id,
    value: "learner grading calls are unavailable"
  });
  assert.equal(prematureResponse.code, "UNKNOWN_EVIDENCE", `${definition.id}: portable learner grading API is unavailable`);

  const engine = await ScenarioV2Engine.create(definition, { autoStartPlant: false });
  assert.equal((await engine.call("compat.connect", { instanceId: "so101-family", config: { kind: "so101", port: "SIM", cameras: {} } })).ok, true);
  const releasePoseByObject = new Map();
  for (const step of definition.portablePython.referenceActions) {
    assert.deepEqual(new Set(Object.keys(step.action)), new Set(definition.api.physicalProgrammability.actionKeys), `${definition.id}/${step.label}: exact official SOFollower action fields`);
    const sent = await engine.call("compat.send_action", { instanceId: "so101-family", action: step.action, options: {} });
    assert.equal(sent.ok, true, `${definition.id}/${step.label}: public action`);
    for (let tick = 0; tick < Math.ceil(step.hold_seconds / engine.plant.tickSeconds); tick += 1) engine.plant.tick();
    assert.equal(engine.plant.fault, null, `${definition.id}/${step.label}: collision-clear plant motion`);
    if (step.label === "place_contact") {
      const held = Object.values(engine.state.objects).find((object) => object.attachedTo === "default");
      assert.ok(held?.attachmentTransform, `${definition.id}: placement retains the live contact-captured attachment transform until opening`);
      releasePoseByObject.set(held.id, {
        positionMm: [...held.worldPositionMm],
        rotationMatrix: [...held.worldRotationMatrix]
      });
    }
  }
  await engine.call("compat.disconnect", { instanceId: "so101-family" });
  const run = engine.snapshot();
  assert.equal(run.grade.passed, true, `${definition.id}: authoritative portable grade`);
  assert.deepEqual(run.rootPose.positionMm, [0, 0, 0], `${definition.id}: fixed base`);
  for (const object of definition.objects) {
    const contact = run.eventLog.findIndex((event) => event.type === "CONTACT" && event.objectId === object.id);
    const attach = run.eventLog.findIndex((event) => event.type === "ATTACH_OBJECT" && event.objectId === object.id);
    const place = run.eventLog.findIndex((event) => event.type === "PLACE_CONTACT" && event.objectId === object.id);
    const detach = run.eventLog.findIndex((event) => event.type === "DETACH_OBJECT" && event.objectId === object.id);
    assert.ok(contact >= 0 && attach > contact && place > attach && detach > place, `${definition.id}/${object.id}: FK-contact-gated attach/place/release`);
    const attachEvent = run.eventLog[attach];
    assert.deepEqual(new Set(attachEvent.contactBodies), new Set([
      "gripper_link__wrist_roll_follower_so101_v1_stl_1",
      "moving_jaw_so101_v1_link__moving_jaw_so101_v1_stl_0",
    ]), `${definition.id}/${object.id}: exact opposing rendered contact patches touched before attachment`);
    assert.equal(attachEvent.opposedPinch, true, `${definition.id}/${object.id}: attachment requires the opposed-pinch contract`);
    assert.ok(attachEvent.graspConstraint.gripperValue < 85, `${definition.id}/${object.id}: rigid apparatus must stop commanded overclosure at first contact`);
    assert.ok(attachEvent.graspConstraint.witnesses.fixed.penetrationMm <= 1 && attachEvent.graspConstraint.witnesses.moving.penetrationMm <= 1, `${definition.id}/${object.id}: contact penetration limit`);
    if (object.physicalRest.geometry.radialProfileMm) {
      for (const [jaw, witness] of Object.entries(attachEvent.graspConstraint.witnesses)) {
        assert.ok(witness.rendererSurface?.gapMm <= 1.5, `${definition.id}/${object.id}/${jaw}: jaw witness touches the shared rendered radial surface before attachment`);
      }
    }
    const detachEvent = run.eventLog[detach];
    const preOpenPose = releasePoseByObject.get(object.id);
    assert.ok(preOpenPose, `${definition.id}/${object.id}: captured live placement pose before opening`);
    assert.ok(distance(preOpenPose.positionMm, detachEvent.worldPositionMm) < 0.01, `${definition.id}/${object.id}: opening releases at the actual gripper pose without translation teleport`);
    assert.ok(Math.max(...preOpenPose.rotationMatrix.map((value, index) => Math.abs(value - detachEvent.worldRotationMatrix[index]))) < 0.001, `${definition.id}/${object.id}: opening does not snap object orientation`);
    const rest = validateRestPose(definition, object, {
      position: detachEvent.worldPositionMm,
      rotation: detachEvent.worldRotationMatrix
    }, `${object.id}_destination`);
    assert.equal(rest.ok, true, `${definition.id}/${object.id}: released pose is level, nonpenetrating, and stably supported (${rest.reasons.join("; ")})`);
  }
  references += 1;

  for (const execution of definition.validation.acceptedAlternates) {
    assert.equal(execution.calls, undefined, `${definition.id}/${execution.id}: symbolic learner calls removed`);
    assert.equal(execution.portableProgram.learnerGradingCalls, false);
    alternates += 1;
  }

  for (const execution of definition.validation.negativeCases) {
    assert.equal(execution.calls, undefined, `${definition.id}/${execution.id}: symbolic learner calls removed`);
    assert.equal(execution.portableNegative, true);
    negatives += 1;
  }

  const fixedRootProbe = await ScenarioV2Engine.create(definition);
  await assert.rejects(
    () => fixedRootProbe.applyTrajectorySample({ rootPose: { positionMm: [10, 0, 0], headingDeg: 0 } }, 0),
    /Fixed robot root/
  );
  const fixedRootGrade = fixedRootProbe.snapshot().grade;
  assert.ok(fixedRootGrade.prohibited.some((item) => item.id === "fixed_base_moved" && item.triggered));
  assert.ok(fixedRootGrade.causal.some((item) => item.code === "FIXED_ROOT_MOVED"));

  const prematureAttach = await ScenarioV2Engine.create(definition, { autoStartPlant: false });
  await prematureAttach.call("compat.connect", { instanceId: "premature", config: { kind: "so101", port: "SIM", cameras: {} } });
  const initialObjectPoses = Object.fromEntries(Object.values(prematureAttach.state.objects).map((object) => [object.id, [...object.worldPositionMm]]));
  await prematureAttach.call("compat.send_action", { instanceId: "premature", action: { "gripper.pos": 85 }, options: {} });
  for (let tick = 0; tick < 50; tick += 1) prematureAttach.plant.tick();
  assert.equal(prematureAttach.snapshot().eventLog.some((event) => event.type === "ATTACH_OBJECT"), false, `${definition.id}: closure away from contact cannot auto-attach`);
  Object.values(prematureAttach.state.objects).forEach((object) => assert.deepEqual(object.worldPositionMm, initialObjectPoses[object.id], `${definition.id}/${object.id}: premature closure cannot teleport apparatus`));
  prematureAttach.dispose();

  if (definition === definitions[0]) {
    const unsupportedRelease = await ScenarioV2Engine.create(definition, { autoStartPlant: false });
    await unsupportedRelease.call("compat.connect", { instanceId: "unsupported-release", config: { kind: "so101", port: "SIM", cameras: {} } });
    const lastLiftIndex = definition.portablePython.referenceActions.findLastIndex((step) => step.label === "lift");
    assert.ok(lastLiftIndex >= 0, `${definition.id}: unsupported-release probe requires a generated lift`);
    for (const step of definition.portablePython.referenceActions.slice(0, lastLiftIndex + 1)) {
      const sent = await unsupportedRelease.call("compat.send_action", { instanceId: "unsupported-release", action: step.action, options: {} });
      assert.equal(sent.ok, true, `${definition.id}/${step.label}: unsupported-release probe action`);
      for (let tick = 0; tick < Math.ceil(step.hold_seconds / unsupportedRelease.plant.tickSeconds); tick += 1) unsupportedRelease.plant.tick();
      assert.equal(unsupportedRelease.plant.fault, null, `${definition.id}/${step.label}: unsupported-release probe remains collision-clear`);
    }
    const held = Object.values(unsupportedRelease.state.objects).find((object) => object.attachedTo === "default");
    assert.ok(held, `${definition.id}: apparatus is held above support before the negative release probe`);
    assert.equal((await unsupportedRelease.call("compat.send_action", { instanceId: "unsupported-release", action: { "gripper.pos": 0 }, options: {} })).ok, true);
    let detachEvent = null;
    for (let tick = 0; tick < 50 && !detachEvent; tick += 1) {
      unsupportedRelease.plant.tick();
      detachEvent = unsupportedRelease.state.eventLog.find((event) => event.type === "DETACH_OBJECT" && event.objectId === held.id) || null;
    }
    assert.ok(detachEvent, `${definition.id}: opening in free space releases the apparatus`);
    assert.equal(detachEvent.stableRest, false, `${definition.id}: unsupported opening cannot be reported as stable placement`);
    assert.equal(detachEvent.unsupportedRelease, true, `${definition.id}: free-space release is explicitly classified as unsupported`);
    assert.equal(unsupportedRelease.state.eventLog.some((event) => event.type === "PLACE_CONTACT" && event.objectId === held.id), false, `${definition.id}: unsupported release earns no placement contact`);
    assert.ok(unsupportedRelease.state.objects[held.id].worldPositionMm[1] < detachEvent.worldPositionMm[1], `${definition.id}: unsupported apparatus begins a gravity-driven fall instead of hovering or teleporting`);
    unsupportedRelease.dispose();
  }

  if (definition.api.level !== "guided") {
    const directManipulation = await ScenarioV2Engine.create(definition);
    const object = definition.objects[0];
    await directManipulation.call("robot.grasp", { objectId: object.id, contactFrame: `${object.id}_contact` });
    await directManipulation.call("robot.release", { objectId: object.id, frameId: `${object.id}_destination` });
    assert.equal(directManipulation.snapshot().grade.passed, false, `${definition.id}: direct calls cannot bypass route outcomes`);
  }

  assert.equal(definition.validation.referenceExecutions[0].portableProgram.learnerGradingCalls, false);
}

console.log("SO-101 ScenarioV2 family acceptance passed:");
console.log(`- ${definitions.length} schemas and exact v1 rank/robot/assistance successor mappings`);
console.log(`- ${reachableFrames} independently solved object-specific frames with geometric clearance checks`);
console.log(`- ${references} portable references passed hidden outcomes, FK-contact order, and fixed-base checks`);
console.log(`- ${alternates} accepted-alternate records preserve portable non-learner grading metadata`);
console.log(`- ${negatives} negative records preserve portable-negative metadata without symbolic learner calls`);
