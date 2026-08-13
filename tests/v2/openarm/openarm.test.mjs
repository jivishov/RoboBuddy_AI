import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScenarioV2Engine,
  forwardKinematics,
  loadRobotModel,
  modelClaim,
  stateCollisionReport,
  validateScenarioV2
} from "../../../lab/v2/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FAMILY = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "openarm");
const files = (await readdir(FAMILY)).filter((name) => name.endsWith(".json")).sort();
assert.equal(files.length, 10, "OpenArm must author exactly ten v2 definitions");
const definitions = await Promise.all(files.map(async (name) => JSON.parse(await readFile(resolve(FAMILY, name), "utf8"))));

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
  let sampleCount = 0;
  let previousBaseYaw = null;
  let minimumEffectorSeparationMm = Infinity;
  const engine = await ScenarioV2Engine.create(definition, {
    onSample: (_sample, _index, state) => {
      sampleCount += 1;
      assert.deepEqual(state.rootPose.positionMm, [0,0,0], `${definition.id}: fixed root translated`);
      const baseYaw = Number(state.jointState.base_yaw);
      if (previousBaseYaw !== null) assert.ok(Math.abs(baseYaw - previousBaseYaw) <= 4.001, `${definition.id}: shared base_yaw path discontinuity`);
      previousBaseYaw = baseYaw;

      const fixtureCheck = stateCollisionReport(
        model,
        state.jointState,
        [{ id: fixture.id, ...fixture.collisionProxy }],
        { basePose: state.rootPose }
      );
      assert.equal(fixtureCheck.ok, true, `${definition.id}: executed sample intersects visible fixture proxy`);

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

  assert.deepEqual(definition.modelClaim, canonicalClaim, `${definition.id}: exact canonical model claim`);
  assert.deepEqual(definition.modelClaim.unsupportedPhysics, ["torque control","force control","payload claim","certified mechanical stand"]);
  assert.ok(!/(provides|supports|simulates)\s+(force|torque|payload|fluid|thermal|calibration|collision recovery)/i.test(JSON.stringify(definition)));

  assert.equal(definition.fixtures.every((fixture) => fixture.visible), true);
  const fixture = definition.fixtures[0];
  assert.equal(fixture.collisionProxy.type, "box");
  assert.deepEqual(fixture.collisionProxy.centerMm, [350,700,0]);
  assert.deepEqual(fixture.collisionProxy.halfExtentsMm, [30,70,70]);
  assert.deepEqual(fixture.contactFrames, ["left_place_contact", "right_place_contact"]);
  const supportedFrames = new Set(definition.fixtures.map((item) => item.supportsFrame).filter(Boolean));
  assert.deepEqual([...supportedFrames].sort(), ["left_contact", "left_handoff", "right_contact", "right_handoff"]);
  definition.fixtures.slice(1).forEach((support) => {
    const frame = definition.frames[support.supportsFrame];
    assert.ok(frame, `${definition.id}: support references an unknown frame`);
    assert.equal(Math.abs(frame.positionMm[0] - support.positionMm[0]), 0);
    assert.equal(Math.abs(frame.positionMm[2] - support.positionMm[2]), 0);
    assert.equal(frame.positionMm[1] - support.positionMm[1], 21, `${definition.id}: support pad must sit directly below its object frame`);
  });

  assert.equal(definition.objects.every((object) => object.visible && object.visual?.type), true);
  assert.equal(definition.objects.every((object) => object.initialState?.contentsSimulation === "not modeled"), true);
  assert.equal(definition.grasps.length, 2);
  assert.equal(definition.grasps[0].effector, "left");
  assert.equal(definition.grasps[1].effector, "right");

  const process = definition.processModels[0];
  assert.equal(process.discrete && process.contactGated, true);
  assert.equal(process.prerequisites.length, 12, `${definition.id}: process needs state, contact, attach, place, detach, and retreat prerequisites`);

  for (const side of ["left","right"]) {
    for (const suffix of ["approach","contact","lift","handoff","place_contact","retreat"]) {
      const frame = definition.frames[`${side}_${suffix}`];
      assert.ok(frame, `${definition.id}: missing ${side}_${suffix}`);
      assert.equal(frame.chainId, side);
    }
    assert.ok(distance(definition.frames[`${side}_approach`].positionMm, definition.frames[`${side}_contact`].positionMm) > 50);
    assert.ok(definition.frames[`${side}_lift`].positionMm[1] > definition.frames[`${side}_contact`].positionMm[1]);
    assert.deepEqual(definition.frames[`${side}_place_contact`].positionMm, definition.frames[`${side}_handoff`].positionMm);
    assert.equal(definition.frames[`${side}_place_contact`].coincidentWith, `${side}_handoff`);
    assert.ok(definition.frames[`${side}_place_contact`].coincidenceRationale.includes("teleport"));
  }
  for (const suffix of ["approach","contact","lift","handoff","place_contact","retreat"]) {
    assert.ok(distance(definition.frames[`left_${suffix}`].positionMm, definition.frames[`right_${suffix}`].positionMm) > 300, `${definition.id}: left/right ${suffix} frames collapsed`);
  }

  const evidence = definition.evidenceRequirements[0];
  assert.equal(definition.api.starterEvidenceValues && Object.keys(definition.api.starterEvidenceValues).length, 0);
  assert.equal(evidence.kind, "learner-recorded");
  assert.ok(evidence.availableWhen && evidence.requiresEvent);
  assert.ok(new RegExp(evidence.valuePattern, "i").test(observationValue(definition)));
  assert.equal(new RegExp(evidence.valuePattern, "i").test("confirmed"), false);

  const prematureEngine = await ScenarioV2Engine.create(definition);
  const premature = await prematureEngine.call("lab.record_evidence", {
    requirementId: evidence.id,
    value: observationValue(definition)
  });
  assert.equal(premature.ok, false, `${definition.id}: evidence recorded before its gate`);
  assert.equal(premature.code, "EVIDENCE_NOT_AVAILABLE");
  assert.deepEqual(prematureEngine.snapshot().evidence, []);

  for (const execution of definition.validation.referenceExecutions) {
    const observed = await executeObserved(definition, execution);
    const { engine, run } = observed;
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: ${JSON.stringify(run.results.filter((item) => !item.ok))}`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: reference must pass`);
    assertContactCausality(definition, run);
    const before = engine.snapshot().evidence.length;
    const invalidEvidence = await engine.call("lab.record_evidence", { requirementId: evidence.id, value: "confirmed" });
    assert.equal(invalidEvidence.ok, false, `${definition.id}: content-free confirmation was accepted`);
    assert.equal(invalidEvidence.code, "EVIDENCE_NOT_AVAILABLE");
    assert.equal(engine.snapshot().evidence.length, before);
    observedSamples += observed.sampleCount;
    minimumObservedSeparationMm = Math.min(minimumObservedSeparationMm, observed.minimumEffectorSeparationMm);
    references += 1;
  }

  for (const execution of definition.validation.acceptedAlternates) {
    const observed = await executeObserved(definition, execution);
    const { run } = observed;
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: ${JSON.stringify(run.results.filter((item) => !item.ok))}`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: alternate must pass`);
    assertContactCausality(definition, run);
    observedSamples += observed.sampleCount;
    minimumObservedSeparationMm = Math.min(minimumObservedSeparationMm, observed.minimumEffectorSeparationMm);
    alternates += 1;
  }

  assert.deepEqual(
    definition.validation.negativeCases.map((item) => item.id),
    ["negative-cross-arm-effector", "negative-missing-evidence", "negative-process-before-placement"]
  );
  for (const execution of definition.validation.negativeCases) {
    const run = await (await ScenarioV2Engine.create(definition)).executeProgram(execution.calls);
    assert.equal(run.grade.passed, false, `${definition.id}/${execution.id}: negative must fail`);
    if (execution.expectedFailureKind === "prohibited") {
      assert.equal(run.ok, true, `${definition.id}/${execution.id}: wrong-arm call should execute but be rejected by observable grading`);
      assert.ok(run.grade.prohibited.some((item) => item.id === "morphology_invalid_cross_arm_contact" && item.triggered));
    }
    if (execution.expectedFailureKind === "evidence") {
      assert.equal(run.ok, true, `${definition.id}/${execution.id}: omitted evidence is a grade failure, not an API failure`);
      assert.ok(run.grade.goals.every((item) => item.passed));
      assert.ok(run.grade.evidence.some((item) => !item.passed));
    }
    if (execution.expectedFailureKind === "causal") {
      assert.equal(run.ok, false);
      assert.ok(run.results.some((item) => item.code === "PROCESS_PREREQUISITE"));
      assert.equal(run.state.eventLog.some((item) => item.type === "PROCESS_COMMIT"), false);
    }
    negatives += 1;
  }
}

assert.equal(references, 10);
assert.equal(alternates, 10);
assert.equal(negatives, 30);
assert.ok(observedSamples >= references + alternates, "Every positive execution must receive focused geometry checks");
assert.ok(minimumObservedSeparationMm >= 300);

console.log("OpenArm v2 critical family checks passed:");
console.log("- 10 one-to-one successors, corrected migration classes, exact canonical claims, and explicit visual approximations");
console.log("- contact/attach/place/detach/process/evidence causality and empty starter evidence verified");
console.log("- 10 references and 10 reversed-order/different-seed alternates passed with fixed-root, shared-base continuity, fixture-proxy, and coarse inter-effector checks");
console.log(`- ${observedSamples} executed trajectory samples checked; minimum configured inter-effector separation ${minimumObservedSeparationMm.toFixed(1)} mm`);
console.log("- 30 wrong-arm/evidence/prerequisite negatives failed in their declared category");
