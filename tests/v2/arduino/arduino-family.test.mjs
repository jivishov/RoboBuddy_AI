import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ScenarioV2Engine,
  evaluatePredicate,
  loadRobotModel,
  methodAvailable,
  modelClaim,
  validateScenarioV2
} from "../../../lab/v2/index.js";

const DEFINITIONS = resolve("missions", "lab-assistant", "v2", "definitions", "arduino");
const EXPECTED_LEGACY_IDS = [
  "arduino-arm-01-balance-placement",
  "arduino-arm-02-volume-staging",
  "arduino-arm-03-cuvette-insertion",
  "arduino-arm-04-filter-paper-setup",
  "arduino-arm-05-flask-under-burette",
  "arduino-arm-06-cool-then-weigh",
  "arduino-arm-07-chromatography-paper",
  "arduino-arm-08-blank-read-return",
  "arduino-arm-09-burette-condition-fill",
  "arduino-arm-10-two-stage-drying"
];
const EXPECTED_CLASSES = ["B", "A", "B", "B", "A", "B", "B", "B", "C", "C"];
const FRAME_ARGUMENTS = ["approachFrame", "contactFrame", "liftFrame", "destinationFrame", "placeFrame", "retreatFrame"];
const MIN_DISTINCT_FRAME_DISTANCE_MM = 40;

const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
const lastCommand = (result) => result.state.commandLog.at(-1);
const transportSignature = (run) => run.results.filter((result) => result.code === "TRANSPORT_COMPLETE").map((result) => ({
  objectId: lastCommand(result).args.objectId,
  sampleCount: result.executor.sampleCount,
  lastJointState: result.executor.lastSample.jointState
}));

function assertContactCausality(definition, run, executionId) {
  const events = run.state.eventLog;
  events.forEach((event, index) => {
    if (event.type === "ATTACH_OBJECT") {
      const prior = events[index - 1];
      assert.equal(prior?.type, "CONTACT", `${definition.id}/${executionId}: attach must immediately follow contact`);
      assert.equal(prior.objectId, event.objectId, `${definition.id}/${executionId}: attach contact must name the same object`);
    }
    if (event.type === "PROCESS_COMMIT") {
      const prior = events[index - 1];
      assert.equal(prior?.type, "PROCESS_CONTACT", `${definition.id}/${executionId}: process commit must immediately follow process contact`);
      assert.equal(prior.processId, event.processId, `${definition.id}/${executionId}: process contact must name the same process`);
    }
    if (event.type === "DETACH_OBJECT") {
      const priorPlace = events.slice(0, index).findLast((item) => item.type === "PLACE_CONTACT" && item.objectId === event.objectId);
      assert.ok(priorPlace, `${definition.id}/${executionId}: detach must follow placement contact`);
      assert.equal(priorPlace.frameId, event.frameId, `${definition.id}/${executionId}: detach and placement contact frames must agree`);
    }
  });
}

function assertStaticReferences(definition, successfulExecutions) {
  const fixtureIds = new Set(definition.fixtures.map((item) => item.id));
  const objectIds = new Set(definition.objects.map((item) => item.id));
  const processById = new Map(definition.processModels.map((item) => [item.id, item]));

  definition.fixtures.forEach((fixture) => {
    assert.ok(definition.frames[fixture.frameId], `${definition.id}/${fixture.id}: visible fixture must use a discoverable frame`);
    assert.equal(fixture.visible, true);
  });
  definition.objects.forEach((object) => assert.ok(definition.frames[object.initialFrame], `${definition.id}/${object.id}: initial frame must exist`));
  definition.grasps.forEach((grasp) => {
    assert.ok(objectIds.has(grasp.objectId), `${definition.id}/${grasp.id}: grasp object must exist`);
    assert.equal(definition.frames[grasp.contactFrame]?.role, "contact", `${definition.id}/${grasp.id}: grasp must use a contact-role frame`);
    if (grasp.fixtureId) assert.ok(fixtureIds.has(grasp.fixtureId), `${definition.id}/${grasp.id}: grasp fixture must exist`);
  });
  definition.processModels.forEach((process) => {
    assert.equal(process.discrete, true);
    assert.equal(process.contactGated, true);
    assert.ok(fixtureIds.has(process.fixtureId), `${definition.id}/${process.id}: every process must pin its visible contact fixture`);
  });
  Object.entries(definition.frames).forEach(([frameId, frame]) => {
    if (!frame.contactFixtureId) return;
    const fixture = definition.fixtures.find((item) => item.id === frame.contactFixtureId);
    assert.ok(fixture, `${definition.id}/${frameId}: contact fixture must exist`);
    assert.equal(fixture.frameId, frameId, `${definition.id}/${frameId}: contact fixture and contact frame must be co-located by identity`);
  });

  for (const execution of successfulExecutions) {
    const objectLocations = Object.fromEntries(definition.objects.map((object) => [object.id, object.initialFrame]));
    for (const call of execution.calls) {
      assert.equal(methodAvailable(call.method, definition.api.level), true, `${definition.id}/${execution.id}: ${call.method} must be available at ${definition.api.level}`);
      if (call.method === "skills.transport") {
        assert.ok(objectIds.has(call.args.objectId), `${definition.id}/${execution.id}: transported object must exist`);
        assert.equal(objectLocations[call.args.objectId], call.args.contactFrame, `${definition.id}/${execution.id}: pickup contact must equal the object's observable current frame`);
        assert.equal(definition.frames[call.args.approachFrame]?.role, "approach");
        assert.equal(definition.frames[call.args.contactFrame]?.role, "contact");
        assert.equal(definition.frames[call.args.liftFrame]?.role, "lift");
        assert.ok(["destination", "contact"].includes(definition.frames[call.args.destinationFrame]?.role));
        assert.equal(definition.frames[call.args.retreatFrame]?.role, "retreat");
        assert.ok(definition.grasps.some((grasp) => grasp.objectId === call.args.objectId && grasp.contactFrame === call.args.contactFrame), `${definition.id}/${execution.id}: transport must have a morphology-valid grasp at its actual contact frame`);
        if (call.args.processId) {
          const process = processById.get(call.args.processId);
          assert.ok(process, `${definition.id}/${execution.id}: transport process must exist`);
          assert.equal(call.args.processValue, process.completeState, `${definition.id}/${execution.id}: transport process value must match its declared complete state`);
          assert.equal(process.fixtureId, definition.frames[call.args.destinationFrame].contactFixtureId, `${definition.id}/${execution.id}: transport process must commit at the destination's visible contact fixture`);
        }
        objectLocations[call.args.objectId] = call.args.destinationFrame;
      }
      if (call.method === "skills.fixture_operation") {
        const process = processById.get(call.args.processId);
        assert.ok(process, `${definition.id}/${execution.id}: fixture process must exist`);
        assert.ok(objectIds.has(call.args.objectId), `${definition.id}/${execution.id}: fixture-operation object must exist`);
        assert.ok(fixtureIds.has(call.args.fixtureId), `${definition.id}/${execution.id}: fixture-operation fixture must exist`);
        assert.equal(call.args.fixtureId, process.fixtureId, `${definition.id}/${execution.id}: fixture operation must use the process's pinned fixture`);
        assert.equal(call.args.value, process.completeState, `${definition.id}/${execution.id}: fixture-operation value must match its declared complete state`);
      }
      assert.ok(!Object.keys(call.args || {}).some((key) => ["jointState", "joints", "rootPose", "basePositionMm"].includes(key)), `${definition.id}/${execution.id}: validation calls must not hide target joint or root tuples`);
    }
  }
}

async function executeSafelyOrdered(definition, execution) {
  const engine = await ScenarioV2Engine.create(definition);
  const results = [];
  for (const call of execution.calls) {
    if (call.method === "skills.transport" && call.args.processId) {
      const process = definition.processModels.find((item) => item.id === call.args.processId);
      for (const prerequisite of process.prerequisites) {
        if (prerequisite.op === "event" && prerequisite.match?.type === "PLACE_CONTACT") {
          assert.equal(prerequisite.match.objectId, call.args.objectId, `${definition.id}/${execution.id}: placement-event prerequisite must name the transported object`);
          assert.equal(prerequisite.match.frameId, call.args.destinationFrame, `${definition.id}/${execution.id}: placement-event prerequisite must name the transport destination`);
          continue;
        }
        assert.equal(evaluatePredicate(engine.state, prerequisite), true, `${definition.id}/${execution.id}: transport process prerequisite must be true before motion begins`);
      }
    }
    const response = await engine.call(call.method, call.args || {});
    results.push(response);
    if (!response.ok) break;
    if (call.method === "skills.transport" && call.args.processId) {
      const process = definition.processModels.find((item) => item.id === call.args.processId);
      assert.equal(engine.state.processes[process.id].state, process.completeState, `${definition.id}/${execution.id}: transport process must commit its declared state`);
      process.prerequisites.forEach((prerequisite) => assert.equal(evaluatePredicate(engine.state, prerequisite), true, `${definition.id}/${execution.id}: transport process prerequisite must be observable at commit`));
    }
  }
  return {
    ok: results.every((item) => item.ok),
    results,
    grade: engine.snapshot().grade,
    state: engine.snapshot()
  };
}

const files = (await readdir(DEFINITIONS)).filter((name) => name.endsWith(".json")).sort();
assert.equal(files.length, 10, "Arduino family must contain exactly ten ScenarioV2 definitions");
const definitions = await Promise.all(files.map(async (file) => JSON.parse(await readFile(resolve(DEFINITIONS, file), "utf8"))));
definitions.sort((a, b) => a.rank - b.rank);

assert.deepEqual(definitions.map((task) => task.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.deepEqual(definitions.map((task) => task.supersedes), EXPECTED_LEGACY_IDS);
assert.deepEqual(definitions.map((task) => task.migration.class), EXPECTED_CLASSES);
assert.deepEqual(definitions.map((task) => task.legacyClassification), EXPECTED_CLASSES);
assert.ok(definitions.every((task) => task.schemaVersion === 2 && task.canonicalModelId === "arduino_arm"));

const model = await loadRobotModel("arduino_arm");
const canonicalClaim = modelClaim("arduino_arm");
let references = 0;
let alternates = 0;
let negatives = 0;
let frames = 0;

for (const definition of definitions) {
  const schema = validateScenarioV2(definition);
  assert.equal(schema.ok, true, `${definition.id}: ${schema.errors.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
  assert.equal(definition.robotId, "arduino_arm");
  assert.equal(definition.canonicalModel.sourceRevision, model.source.revision);
  assert.deepEqual(definition.modelClaim, canonicalClaim, `${definition.id} must preserve the full canonical model claim`);
  assert.deepEqual(new Set(definition.provenance.map((entry) => entry.label)), new Set(["M", "F", "R", "C"]));
  assert.ok(definition.evidenceRequirements.every((item) => item.availableWhen || item.requiresEvent));
  assert.ok(definition.evidenceRequirements.every((item) => !Object.hasOwn(item, "value")), `${definition.id}: evidence requirements must not be prefilled`);
  assert.ok(definition.evidenceRequirements.flatMap((item) => item.allowedValues || []).every((value) => !/\d/.test(String(value))), `${definition.id}: configured evidence must not invent a numeric measurement`);
  assert.ok(definition.validation.negativeCases.every((execution) => execution.calls.length > 0), `${definition.id}: negative cases must exercise a real rejected or incomplete action`);
  if (definition.migration.class === "B") assert.ok(definition.fixtures.length > 0 && definition.fixtures.every((item) => item.visible === true));
  if (definition.migration.class === "C") assert.match(definition.migration.redesignRationale, /does not model|cannot substantiate/i);

  const frameEntries = Object.entries(definition.frames);
  for (let left = 0; left < frameEntries.length; left += 1) {
    const [leftId, leftFrame] = frameEntries[left];
    assert.equal(leftFrame.chainId, "default");
    assert.equal(leftFrame.positionMm.length, 3);
    assert.ok(leftFrame.positionMm.every(Number.isFinite));
    assert.ok(!Object.keys(leftFrame).some((key) => /joint/i.test(key)), `${definition.id}/${leftId}: frames must not contain hidden joint targets`);
    for (let right = left + 1; right < frameEntries.length; right += 1) {
      const [rightId, rightFrame] = frameEntries[right];
      assert.ok(distance(leftFrame.positionMm, rightFrame.positionMm) >= MIN_DISTINCT_FRAME_DISTANCE_MM, `${definition.id}: ${leftId} and ${rightId} are semantically duplicate frames`);
    }
    frames += 1;
  }

  const successfulExecutions = [...definition.validation.referenceExecutions, ...definition.validation.acceptedAlternates];
  assertStaticReferences(definition, successfulExecutions);
  const allCalls = successfulExecutions.flatMap((execution) => execution.calls);
  const transportedFrameIds = new Set(allCalls.filter((call) => call.method === "skills.transport").flatMap((call) => FRAME_ARGUMENTS.map((key) => call.args[key]).filter(Boolean)));
  Object.keys(definition.frames).forEach((frameId) => assert.ok(transportedFrameIds.has(frameId), `${definition.id}/${frameId}: frame must be exercised by collision-checked validation transport`));

  for (const requirement of definition.evidenceRequirements) {
    const engine = await ScenarioV2Engine.create(definition);
    const premature = await engine.call("lab.record_evidence", { requirementId: requirement.id, value: requirement.allowedValues?.[0] || "premature observation" });
    assert.equal(premature.ok, false, `${definition.id}/${requirement.id}: evidence must be unavailable before its observable gate`);
    assert.equal(premature.code, "EVIDENCE_NOT_AVAILABLE");
  }

  const referenceRuns = [];
  for (const execution of definition.validation.referenceExecutions) {
    const run = await executeSafelyOrdered(definition, execution);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: reference API calls must execute`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: reference outcome and evidence must pass`);
    assert.deepEqual(run.state.rootPose.positionMm, [0, 0, 0], `${definition.id}: fixed robot root must not translate`);
    assertContactCausality(definition, run, execution.id);
    referenceRuns.push(run);
    references += 1;
  }

  const alternateRuns = [];
  for (const execution of definition.validation.acceptedAlternates) {
    const run = await executeSafelyOrdered(definition, execution);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: alternate API calls must execute`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: legitimate alternate must pass`);
    assert.deepEqual(run.state.rootPose.positionMm, [0, 0, 0], `${definition.id}: alternate must preserve the fixed root`);
    assertContactCausality(definition, run, execution.id);
    alternateRuns.push(run);
    alternates += 1;
  }
  assert.notDeepEqual(transportSignature(referenceRuns[0]), transportSignature(alternateRuns[0]), `${definition.id}: accepted alternate must produce a materially distinct transport execution`);

  for (const execution of definition.validation.negativeCases) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.grade.passed, false, `${definition.id}/${execution.id}: negative case must fail`);
    if (execution.expectedFailureKind === "goal") assert.ok(run.grade.goals.some((item) => !item.passed));
    if (execution.expectedFailureKind === "evidence") assert.ok(run.grade.evidence.some((item) => !item.passed));
    if (execution.expectedFailureKind === "prohibited") assert.ok(run.grade.prohibited.some((item) => item.triggered));
    if (execution.expectedFailureKind === "causal") assert.ok(run.grade.causal.length > 0 || run.results.some((item) => !item.ok));
    negatives += 1;
  }
}

console.log("Arduino ScenarioV2 critical family checks passed:");
console.log(`- ${definitions.length} one-to-one successors and ${frames} meaningfully separated canonical-chain frames`);
console.log(`- ${references} references and ${alternates} materially distinct alternates passed outcome plus gated evidence`);
console.log(`- ${negatives} non-empty negatives failed for their declared category`);
console.log("- pickup continuity, morphology-valid grasps, process prerequisites, pinned fixtures, and event adjacency verified");
console.log("- every named frame was exercised by collision-checked transport; fixed root and unsupported-physics claim preserved");
