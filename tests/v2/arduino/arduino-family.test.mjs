import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ScenarioV2Engine,
  loadRobotModel,
  modelClaim,
  validateScenarioV2
} from "../../../lab/v2/index.js";

const DEFINITIONS = resolve("missions", "lab-assistant", "v2", "definitions", "arduino");
const EXPECTED_LEGACY_IDS = Array.from({ length: 10 }, (_, index) => {
  const suffixes = [
    "balance-placement",
    "volume-staging",
    "cuvette-insertion",
    "filter-paper-setup",
    "flask-under-burette",
    "cool-then-weigh",
    "chromatography-paper",
    "blank-read-return",
    "burette-condition-fill",
    "two-stage-drying"
  ];
  return `arduino-arm-${String(index + 1).padStart(2, "0")}-${suffixes[index]}`;
});
const EXPECTED_CLASSES = ["A", "A", "B", "B", "A", "B", "B", "B", "C", "C"];
const FRAME_ARGUMENTS = ["approachFrame", "contactFrame", "liftFrame", "destinationFrame", "placeFrame", "retreatFrame"];

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

for (const definition of definitions) {
  const schema = validateScenarioV2(definition);
  assert.equal(schema.ok, true, `${definition.id}: ${schema.errors.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
  assert.equal(definition.robotId, "arduino_arm");
  assert.equal(definition.canonicalModel.sourceRevision, model.source.revision);
  assert.deepEqual(definition.modelClaim, canonicalClaim, `${definition.id} must preserve the full canonical model claim`);
  assert.ok(definition.provenance.some((entry) => entry.label === "M"));
  assert.ok(definition.provenance.some((entry) => entry.label === "F"));
  assert.ok(definition.provenance.some((entry) => entry.label === "R"));
  assert.ok(definition.provenance.some((entry) => entry.label === "C"));
  assert.ok(definition.evidenceRequirements.every((item) => item.availableWhen || item.requiresEvent));
  assert.ok(definition.evidenceRequirements.every((item) => !Object.hasOwn(item, "value")), `${definition.id} starter evidence must remain blank`);
  if (definition.migration.class === "B") assert.ok(definition.fixtures.length > 0 && definition.fixtures.every((item) => item.visible === true));
  if (definition.migration.class === "C") assert.match(definition.migration.redesignRationale, /does not model|cannot substantiate/i);

  const allCalls = [
    ...definition.validation.referenceExecutions.flatMap((execution) => execution.calls),
    ...definition.validation.acceptedAlternates.flatMap((execution) => execution.calls)
  ];
  const transportedFrameIds = new Set(allCalls.filter((call) => call.method === "skills.transport").flatMap((call) => FRAME_ARGUMENTS.map((key) => call.args[key]).filter(Boolean)));
  for (const [frameId, frame] of Object.entries(definition.frames)) {
    assert.ok(transportedFrameIds.has(frameId), `${definition.id}/${frameId} must be exercised by a collision-checked validation transport`);
    assert.equal(frame.chainId, "default");
    assert.equal(frame.positionMm.length, 3);
    assert.ok(frame.positionMm.every(Number.isFinite));
  }

  for (const execution of definition.validation.referenceExecutions) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: reference API calls must execute`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: reference outcome and evidence must pass`);
    assert.deepEqual(run.state.rootPose.positionMm, [0, 0, 0], `${definition.id}: fixed robot root must not translate`);
    references += 1;
  }

  for (const execution of definition.validation.acceptedAlternates) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: alternate API calls must execute`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: legitimate alternate must pass`);
    alternates += 1;
  }

  for (const execution of definition.validation.negativeCases) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls || []);
    assert.equal(run.grade.passed, false, `${definition.id}/${execution.id}: negative case must fail`);
    if (execution.expectedFailureKind === "goal") assert.ok(run.grade.goals.some((item) => !item.passed));
    if (execution.expectedFailureKind === "evidence") assert.ok(run.grade.evidence.some((item) => !item.passed));
    if (execution.expectedFailureKind === "prohibited") assert.ok(run.grade.prohibited.some((item) => item.triggered));
    if (execution.expectedFailureKind === "causal") assert.ok(run.grade.causal.length > 0 || run.results.some((item) => !item.ok));
    negatives += 1;
  }
}

console.log("Arduino ScenarioV2 family checks passed:");
console.log(`- ${definitions.length} one-to-one successors with ranks 1..10`);
console.log(`- ${references} references and ${alternates} alternates passed outcome plus evidence`);
console.log(`- ${negatives} negatives failed for their declared category`);
console.log("- every named manipulator frame was consumed by a successful collision-checked transport");
console.log("- fixed root, full model claim, M/F/R/C provenance, visible fixtures, and gated blank evidence verified");
