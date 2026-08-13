import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioV2Engine, loadRobotModel, modelClaim, validateScenarioV2 } from "../../../lab/v2/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FAMILY = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "g1");
const files = (await readdir(FAMILY)).filter((name) => name.endsWith(".json")).sort();
const definitions = await Promise.all(files.map(async (name) => JSON.parse(await readFile(resolve(FAMILY, name), "utf8"))));
const canonical = await loadRobotModel("unitree_g1_29dof");
const canonicalClaim = modelClaim("unitree_g1_29dof");
const expectedSupersedes = [
  "g1-01-empty-tray",
  "g1-02-sealed-sample",
  "g1-03-cuvette-rack",
  "g1-04-filtration-kit",
  "g1-05-waste-carrier",
  "g1-06-cooled-sample-tray",
  "g1-07-reagent-tote",
  "g1-08-spectro-courier-loop",
  "g1-09-gravimetry-logistics",
  "g1-10-lab-runner-shift"
];

assert.equal(definitions.length, 10, "G1 family must contain exactly ten sources");
assert.deepEqual(definitions.map((item) => item.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.deepEqual(definitions.map((item) => item.supersedes), expectedSupersedes);

for (const definition of definitions) {
  const validation = validateScenarioV2(definition);
  assert.equal(validation.ok, true, `${definition.id}: ${validation.errors.map((item) => `${item.path}: ${item.message}`).join("\n")}`);
  assert.equal(definition.schemaVersion, 2);
  assert.equal(definition.robotId, "unitree_g1_29dof");
  assert.equal(definition.canonicalModel.sourceRevision, canonical.source.revision);
  assert.deepEqual(definition.modelClaim, canonicalClaim);
  assert.equal(definition.legacyClassification, definition.migration.class);
  assert.ok(definition.provenance.some((item) => item.label === "M" && item.sourceRef));
  assert.ok(definition.provenance.some((item) => item.label === "F" && item.sourceRef));
  assert.ok(definition.provenance.some((item) => item.label === "R"));
  assert.ok(definition.provenance.some((item) => item.label === "C"));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "approach"));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "contact"));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "lift"));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "destination"));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "retreat"));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "dock"));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "latch"));
  assert.ok(definition.fixtures.every((fixture) => fixture.visible === true));
  assert.ok(definition.objects.filter((item) => item.transportable).every((item) => item.securedCarrier && item.attachmentInterface === canonical.configured.carrierInterface && item.initialState?.contentsSecured === true));
  assert.ok(definition.grasps.every((grasp) => grasp.mode === "secured-carrier-latch" && grasp.attachmentInterface === canonical.configured.carrierInterface));
  assert.ok(definition.processModels.every((process) => process.discrete && process.contactGated && process.prerequisites.length));
  assert.ok(definition.evidenceRequirements.every((item) => item.availableWhen && item.requiresEvent));
  assert.ok(definition.validation.acceptedAlternates.every((alternate) => !definition.validation.referenceExecutions.some((reference) => JSON.stringify(reference.calls) === JSON.stringify(alternate.calls))));

  for (const execution of definition.validation.referenceExecutions) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: ${run.results.find((item) => !item.ok)?.code || "execution failed"}`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: reference must satisfy outcomes and evidence`);
  }
  for (const execution of definition.validation.acceptedAlternates) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: ${run.results.find((item) => !item.ok)?.code || "execution failed"}`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: alternate must satisfy outcomes and evidence`);
  }
  for (const execution of definition.validation.negativeCases) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls || []);
    assert.equal(run.grade.passed, false, `${definition.id}/${execution.id}: negative case must fail grading`);
    if (execution.expectedFailureKind === "evidence") assert.ok(run.grade.evidence.some((item) => !item.passed));
    if (execution.expectedFailureKind === "prohibited") assert.ok(run.grade.prohibited.some((item) => item.triggered));
    if (execution.expectedFailureKind === "causal") assert.ok(run.grade.causal.length || run.results.some((item) => !item.ok));
  }
}

console.log("G1 v2 family acceptance passed: 10 sources, references, alternates, and declared negatives.");
