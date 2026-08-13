import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScenarioV2Engine,
  homeJointState,
  inverseKinematics,
  loadRobotModel,
  methodAvailable,
  modelClaim,
  validateProxyEnclosure,
  validateScenarioV2
} from "../../../lab/v2/index.js";

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
  return Number(fixture.collisionProxy.centerMm[1]) + Number(fixture.collisionProxy.halfExtentsMm[1]);
}

function callsBeforeEvidence(execution) {
  return execution.calls.slice(0, execution.calls.findIndex((call) => call.method === "lab.record_evidence"));
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
  assert.equal(definition.fixtures.length, definition.objects.length * 2, `${definition.id}: pickup and destination fixtures`);
  assert.ok(definition.fixtures.every((fixture) => fixture.visible === true && fixture.configured === true));
  assert.ok(definition.fixtures.every((fixture) => fixture.collisionProxy?.type === "box"));
  assert.ok(definition.grasps.every((grasp) => grasp.mode === "fixture-assisted" && grasp.visible === true));
  assert.ok(Object.values(definition.frames).every((frame) => !Object.hasOwn(frame, "joints") && !Object.hasOwn(frame, "jointState")), `${definition.id} must not expose target joint tuples`);
  assert.equal(new Set(Object.values(definition.frames).map((frame) => JSON.stringify(frame.positionMm))).size, Object.keys(definition.frames).length, `${definition.id}: no duplicated Cartesian frames`);
  assert.ok(definition.evidenceRequirements.every((item) => item.availableWhen && item.requiresEvent));
  assert.ok(definition.evidenceRequirements.every((item) => item.allowedValues?.length === 1));
  assert.equal(Object.hasOwn(definition, "starters"), false, `${definition.id}: no prefilled evidence starter`);
  assert.ok(definition.modelClaim.unsupportedPhysics.includes("force sensing"));
  assert.ok(definition.modelClaim.unsupportedPhysics.includes("payload claim"));

  for (const object of definition.objects) {
    const names = {
      approach: `${object.id}_approach`,
      contact: `${object.id}_contact`,
      lift: `${object.id}_lift`,
      destination: `${object.id}_destination`,
      retreat: `${object.id}_retreat`
    };
    for (const [role, frameId] of Object.entries(names)) {
      assert.equal(definition.frames[frameId]?.role, role, `${definition.id}/${object.id}: ${role} frame`);
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
    assert.ok(definition.frames[names.lift].positionMm[1] - definition.frames[names.contact].positionMm[1] >= 100, `${definition.id}/${object.id}: lift clearance`);
    assert.ok(definition.frames[names.retreat].positionMm[1] - definition.frames[names.destination].positionMm[1] >= 100, `${definition.id}/${object.id}: retreat clearance`);
    assert.ok(distance(definition.frames[names.contact].positionMm, definition.frames[names.destination].positionMm) >= 300, `${definition.id}/${object.id}: source and destination separation`);
    const pickup = definition.fixtures.find((fixture) => fixture.id === `${object.id}_pickup_adapter`);
    const destination = definition.fixtures.find((fixture) => fixture.id === `${object.id}_destination_slot`);
    assert.equal(object.initialFrame, names.contact);
    assert.equal(definition.grasps.find((grasp) => grasp.objectId === object.id)?.fixtureId, pickup.id);
    assert.ok(Math.abs(definition.frames[names.contact].positionMm[1] - fixtureTopY(pickup)) <= 4, `${definition.id}/${object.id}: supported pickup height`);
    assert.ok(Math.abs(definition.frames[names.destination].positionMm[1] - fixtureTopY(destination)) <= 4, `${definition.id}/${object.id}: supported destination height`);
  }

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

  for (const execution of [...definition.validation.referenceExecutions, ...definition.validation.acceptedAlternates]) {
    execution.calls.forEach((call) => {
      assert.ok(methodAvailable(call.method, definition.api.level), `${definition.id}/${execution.id}: ${call.method} is available at ${definition.api.level}`);
    });
  }
  definition.validation.negativeCases.forEach((execution) => execution.calls.forEach((call) => {
    if (!methodAvailable(call.method, definition.api.level)) {
      assert.equal(execution.id, "fixed-base-navigation-rejected", `${definition.id}/${execution.id}: only the deliberate API rejection may call above its level`);
    }
  }));

  const premature = await ScenarioV2Engine.create(definition);
  const prematureResponse = await premature.call("lab.record_evidence", {
    requirementId: definition.evidenceRequirements[0].id,
    value: definition.evidenceRequirements[0].allowedValues[0]
  });
  assert.equal(prematureResponse.code, "EVIDENCE_NOT_AVAILABLE", `${definition.id}: evidence gate before action`);

  for (const execution of definition.validation.referenceExecutions) {
    const phases = [];
    const engine = await ScenarioV2Engine.create(definition, { onSample: (sample) => phases.push(sample.phase) });
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: API calls`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: grade`);
    assert.deepEqual(run.state.rootPose.positionMm, [0, 0, 0], `${definition.id}: fixed base`);
    ["pre_contact", "contact", "lift", "transfer", "place", "retreat"].forEach((phase) => {
      assert.ok(phases.includes(phase), `${definition.id}/${execution.id}: visible ${phase} phase`);
    });
    for (const object of definition.objects) {
      const contact = run.state.eventLog.findIndex((event) => event.type === "CONTACT" && event.objectId === object.id);
      const attach = run.state.eventLog.findIndex((event) => event.type === "ATTACH_OBJECT" && event.objectId === object.id);
      const place = run.state.eventLog.findIndex((event) => event.type === "PLACE_CONTACT" && event.objectId === object.id);
      const detach = run.state.eventLog.findIndex((event) => event.type === "DETACH_OBJECT" && event.objectId === object.id);
      assert.ok(contact >= 0 && attach > contact && place > attach && detach > place, `${definition.id}/${object.id}: contact-gated motion`);
    }
    if (definition.processModels.length) {
      const process = definition.processModels[0];
      const finalObject = definition.objects.at(-1);
      const finalPlace = run.state.eventLog.findIndex((event) => event.type === "PLACE_CONTACT" && event.objectId === finalObject.id);
      const processContact = run.state.eventLog.findIndex((event) => event.type === "PROCESS_CONTACT" && event.processId === process.id);
      const processCommit = run.state.eventLog.findIndex((event) => event.type === "PROCESS_COMMIT" && event.processId === process.id);
      const finalDetach = run.state.eventLog.findIndex((event) => event.type === "DETACH_OBJECT" && event.objectId === finalObject.id);
      const priorDetaches = definition.objects.slice(0, -1).map((object) => run.state.eventLog.findIndex((event) => event.type === "DETACH_OBJECT" && event.objectId === object.id));
      assert.ok(processContact > Math.max(-1, ...priorDetaches), `${definition.id}/${process.id}: prior objects placed before process contact`);
      assert.ok(finalPlace >= 0 && finalDetach > finalPlace && processContact > finalDetach && processCommit > processContact, `${definition.id}/${process.id}: placement, release, then gated process commit`);
    }
    references += 1;
  }

  for (const execution of definition.validation.acceptedAlternates) {
    const referenceTransport = definition.validation.referenceExecutions[0].calls.filter((call) => call.method === "skills.transport");
    const alternateTransport = execution.calls.filter((call) => call.method === "skills.transport");
    assert.deepEqual(alternateTransport.map((call) => call.args.objectId), referenceTransport.map((call) => call.args.objectId), `${definition.id}: alternate preserves safe object order`);
    assert.ok(alternateTransport.every((call, index) => call.args.seed !== referenceTransport[index].args.seed), `${definition.id}: alternate uses distinct IK seeds`);
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: API calls`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: grade`);
    alternates += 1;
  }

  for (const execution of definition.validation.negativeCases) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls || []);
    assert.equal(run.grade.passed, false, `${definition.id}/${execution.id}: must fail`);
    if (execution.expectedFailureKind === "goal") assert.ok(run.grade.goals.some((item) => !item.passed));
    if (execution.expectedFailureKind === "evidence") assert.ok(run.grade.evidence.some((item) => !item.passed));
    if (execution.expectedFailureKind === "prohibited") assert.ok(run.grade.prohibited.some((item) => item.triggered));
    if (execution.expectedFailureKind === "causal") assert.ok(run.grade.causal.length || run.results.some((item) => !item.ok));
    if (execution.id === "missing-second-object" || execution.id === "no-transport") {
      assert.ok(run.grade.goals.some((item) => !item.passed));
      assert.ok(run.grade.evidence.some((item) => !item.passed));
    }
    if (execution.id === "outcome-without-evidence") {
      assert.equal(run.ok, true);
      assert.ok(run.grade.goals.every((item) => item.passed));
      assert.ok(run.grade.prohibited.every((item) => !item.triggered));
      assert.equal(run.grade.causal.length, 0);
    }
    if (execution.id === "premature-evidence" || execution.id === "invalid-evidence-value") {
      assert.equal(run.results.at(-1).code, "EVIDENCE_NOT_AVAILABLE");
    }
    if (execution.id === "process-before-placement") {
      assert.equal(run.results[0].code, "PROCESS_PREREQUISITE");
    }
    if (execution.id === "fixed-base-navigation-rejected") {
      assert.ok(["API_ERROR", "FIXED_ROOT"].includes(run.results[0].code));
    }
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

  if (definition.api.level !== "guided") {
    const directManipulation = await ScenarioV2Engine.create(definition);
    const object = definition.objects[0];
    await directManipulation.call("robot.grasp", { objectId: object.id, contactFrame: `${object.id}_contact` });
    await directManipulation.call("robot.release", { objectId: object.id, frameId: `${object.id}_destination` });
    assert.equal(directManipulation.snapshot().grade.passed, false, `${definition.id}: direct calls cannot bypass route outcomes`);
  }

  const referenceCalls = callsBeforeEvidence(definition.validation.referenceExecutions[0]);
  assert.ok(referenceCalls.every((call) => call.method !== "lab.record_evidence"));
}

console.log("SO-101 ScenarioV2 family acceptance passed:");
console.log(`- ${definitions.length} schemas and exact v1 rank/robot/assistance successor mappings`);
console.log(`- ${reachableFrames} independently solved object-specific frames with geometric clearance checks`);
console.log(`- ${references} reference executions passed outcomes, evidence, phase, contact-order, process-order, and fixed-base checks`);
console.log(`- ${alternates} alternate IK-seed executions preserved the authored safe object order`);
console.log(`- ${negatives} negative cases failed in their declared categories with targeted failure evidence`);
