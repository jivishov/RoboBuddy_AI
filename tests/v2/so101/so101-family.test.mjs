import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScenarioV2Engine,
  loadRobotModel,
  modelClaim,
  validateProxyEnclosure,
  validateScenarioV2
} from "../../../lab/v2/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFINITIONS = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "so101");
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

const files = (await readdir(DEFINITIONS)).filter((name) => name.endsWith(".json")).sort();
assert.equal(files.length, 10, "SO-101 must author exactly ten definitions");
const definitions = await Promise.all(files.map(async (file) => JSON.parse(await readFile(resolve(DEFINITIONS, file), "utf8"))));
assert.deepEqual(definitions.map((item) => item.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.deepEqual(definitions.map((item) => item.supersedes), EXPECTED_SUPERSEDES);

const model = await loadRobotModel("so101_follower");
const canonicalClaim = modelClaim("so101_follower");
assert.equal(validateProxyEnclosure(model, Object.fromEntries(model.joints.map((joint) => [joint.id, joint.home]))).ok, true);

let references = 0;
let alternates = 0;
let negatives = 0;
for (const definition of definitions) {
  const validation = validateScenarioV2(definition, { expectedRobotId: "so101_follower" });
  assert.equal(validation.ok, true, `${definition.id}:\n${validation.errors.map((item) => `${item.path}: ${item.message}`).join("\n")}`);
  assert.equal(definition.schemaVersion, 2);
  assert.equal(definition.legacyClassification, definition.migration.class);
  assert.equal(definition.canonicalModel.sourceRevision, model.source.revision);
  assert.deepEqual(definition.modelClaim, canonicalClaim);
  assert.equal(definition.navigation.fixedBase, true);
  assert.ok(definition.fixtures.every((fixture) => fixture.visible === true));
  assert.ok(definition.grasps.every((grasp) => grasp.mode === "fixture-assisted"));
  assert.ok(Object.values(definition.frames).every((frame) => !Object.hasOwn(frame, "joints") && !Object.hasOwn(frame, "jointState")), `${definition.id} must not expose target joint tuples`);
  assert.ok(definition.evidenceRequirements.every((item) => item.availableWhen || item.requiresEvent));
  assert.ok(definition.modelClaim.unsupportedPhysics.includes("force sensing"));
  assert.ok(definition.modelClaim.unsupportedPhysics.includes("payload claim"));

  for (const execution of definition.validation.referenceExecutions) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: API calls`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: grade`);
    assert.deepEqual(run.state.rootPose.positionMm, [0, 0, 0], `${definition.id}: fixed base`);
    for (const object of definition.objects) {
      const contact = run.state.eventLog.findIndex((event) => event.type === "CONTACT" && event.objectId === object.id);
      const attach = run.state.eventLog.findIndex((event) => event.type === "ATTACH_OBJECT" && event.objectId === object.id);
      const detach = run.state.eventLog.findIndex((event) => event.type === "DETACH_OBJECT" && event.objectId === object.id);
      assert.ok(contact >= 0 && attach > contact && detach > attach, `${definition.id}/${object.id}: contact-gated motion`);
    }
    references += 1;
  }

  for (const execution of definition.validation.acceptedAlternates) {
    assert.ok(definition.validation.referenceExecutions.every((reference) => JSON.stringify(reference.calls) !== JSON.stringify(execution.calls)));
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
    negatives += 1;
  }
}

console.log("SO-101 ScenarioV2 family acceptance passed:");
console.log(`- ${definitions.length} schemas and exact v1 successor mappings`);
console.log(`- ${references} reference executions passed outcome, evidence, contact-order, and fixed-base checks`);
console.log(`- ${alternates} alternate IK seed/safe-order executions passed`);
console.log(`- ${negatives} negative cases failed in their declared categories`);
