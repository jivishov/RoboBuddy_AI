import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioV2Engine, loadRobotModel, modelClaim, validateScenarioV2 } from "../../../lab/v2/index.js";

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
assert.deepEqual(definitions.map((item) => item.id), expectedIds);
assert.deepEqual(definitions.map((item) => item.supersedes), expectedSupersedes);
assert.deepEqual(definitions.map((item) => item.rank), [1,2,3,4,5,6,7,8,9,10]);

const model = await loadRobotModel("openarm_v2_bimanual");
const canonicalClaim = modelClaim("openarm_v2_bimanual");
let references = 0;
let alternates = 0;
let negatives = 0;
for (const definition of definitions) {
  const validation = validateScenarioV2(definition);
  assert.equal(validation.ok, true, `${definition.id}: ${JSON.stringify(validation.errors)}`);
  assert.equal(definition.schemaVersion, 2);
  assert.equal(definition.canonicalModelId, "openarm_v2_bimanual");
  assert.equal(definition.legacyClassification, definition.migration.class);
  assert.equal(definition.coordination.rootTranslationAllowed, false);
  assert.equal(definition.coordination.sharedJointId, "base_yaw");
  assert.deepEqual(definition.coordination.acceptedSafeOrderings, ["left_then_right", "right_then_left"]);
  assert.deepEqual(definition.modelClaim, canonicalClaim, `${definition.id}: exact canonical model claim`);
  assert.deepEqual(definition.modelClaim.unsupportedPhysics, ["torque control","force control","payload claim","certified mechanical stand"]);
  assert.equal(definition.fixtures.every((fixture) => fixture.visible), true);
  assert.equal(definition.objects.every((object) => object.visible), true);
  assert.equal(definition.processModels.every((process) => process.discrete && process.contactGated && process.prerequisites.length === 2), true);
  for (const side of ["left","right"]) {
    for (const suffix of ["approach","contact","lift","handoff","place_contact","retreat"]) {
      const frame = definition.frames[`${side}_${suffix}`];
      assert.ok(frame, `${definition.id}: missing ${side}_${suffix}`);
      assert.equal(frame.chainId, side);
    }
  }
  assert.equal(definition.frames.left_handoff.role, "destination");
  assert.equal(definition.frames.right_handoff.role, "destination");
  assert.equal(definition.evidenceRequirements.every((item) => item.availableWhen || item.requiresEvent), true);

  for (const execution of definition.validation.referenceExecutions) {
    const run = await (await ScenarioV2Engine.create(definition)).executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: ${JSON.stringify(run.results.filter((item) => !item.ok))}`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: reference must pass`);
    assert.deepEqual(run.state.rootPose.positionMm, [0,0,0], `${definition.id}: fixed base translated`);
    references += 1;
  }
  for (const execution of definition.validation.acceptedAlternates) {
    const run = await (await ScenarioV2Engine.create(definition)).executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: ${JSON.stringify(run.results.filter((item) => !item.ok))}`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: alternate must pass`);
    alternates += 1;
  }
  for (const execution of definition.validation.negativeCases) {
    const run = await (await ScenarioV2Engine.create(definition)).executeProgram(execution.calls);
    assert.equal(run.grade.passed, false, `${definition.id}/${execution.id}: negative must fail`);
    if (execution.expectedFailureKind === "goal") assert.ok(run.grade.goals.some((item) => !item.passed));
    if (execution.expectedFailureKind === "evidence") assert.ok(run.grade.evidence.some((item) => !item.passed));
    if (execution.expectedFailureKind === "causal") assert.ok(run.grade.causal.length || run.results.some((item) => !item.ok));
    negatives += 1;
  }
}
assert.equal(references, 10);
assert.equal(alternates, 10);
assert.equal(negatives, 30);
console.log("OpenArm v2 family checks passed:");
console.log("- 10 ordered one-to-one successors with exact canonical model claims");
console.log("- explicit per-arm approach/contact/lift/handoff/place/retreat frames and fixed shared base");
console.log("- 10 reference executions and 10 alternate order/seed executions passed");
console.log("- 30 goal/evidence/causal negative cases failed in their declared category");
