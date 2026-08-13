import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScenarioV2Engine,
  loadRobotModel,
  modelClaim,
  validateScenarioV2
} from "../../../lab/v2/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFINITIONS = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "lekiwi");
const EXPECTED = [
  ["lekiwi-01-beaker-courier", "lekiwi-01-beaker-courier", "A"],
  ["lekiwi-02-glassware-route", "lekiwi-02-sample-fetch", "B"],
  ["lekiwi-03-sample-delivery", "lekiwi-03-mobile-weighing", "B"],
  ["lekiwi-04-filter-station-run", "lekiwi-04-cuvette-rack", "B"],
  ["lekiwi-05-reagent-shuttle", "lekiwi-05-waste-return", "B"],
  ["lekiwi-06-cooling-rack-route", "lekiwi-06-dilution-route", "C"],
  ["lekiwi-07-chromatography-route", "lekiwi-07-filtration-supply", "B"],
  ["lekiwi-08-spectrometer-route", "lekiwi-08-cooled-precipitate", "C"],
  ["lekiwi-09-titration-logistics", "lekiwi-09-spectro-route", "B"],
  ["lekiwi-10-hard-water-logistics", "lekiwi-10-hard-water-logistics", "C"]
];

const files = (await readdir(DEFINITIONS)).filter((name) => name.endsWith(".json")).sort();
assert.equal(files.length, 10, "LeKiwi owns exactly ten ScenarioV2 definitions");
const definitions = await Promise.all(files.map(async (file) => JSON.parse(await readFile(resolve(DEFINITIONS, file), "utf8"))));
const model = await loadRobotModel("lekiwi_sim");
const canonicalClaim = modelClaim("lekiwi_sim");

assert.deepEqual(
  definitions.map((definition) => [definition.id, definition.supersedes, definition.migration.class]),
  EXPECTED,
  "new ids, immutable v1 mappings, and A/B/C classifications remain rank aligned"
);
assert.deepEqual(definitions.map((definition) => definition.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

let references = 0;
let alternates = 0;
let negatives = 0;
for (const definition of definitions) {
  const validation = validateScenarioV2(definition);
  assert.equal(validation.ok, true, validation.errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
  assert.equal(definition.schemaVersion, 2);
  assert.equal(definition.canonicalModelId, "lekiwi_sim");
  assert.equal(definition.legacyClassification, definition.migration.class);
  assert.equal(definition.canonicalModel.sourceRevision, model.source.revision);
  assert.deepEqual(definition.modelClaim, canonicalClaim);
  assert.deepEqual(new Set(definition.provenance.map((entry) => entry.label)), new Set(["M", "F", "R", "C"]));
  assert.ok(definition.fixtures.every((fixture) => fixture.visible === true));
  assert.ok(definition.processModels.every((process) => process.discrete && process.contactGated));
  assert.ok(definition.evidenceRequirements.every((requirement) => requirement.availableWhen || requirement.requiresEvent));
  assert.equal(definition.navigation.planner, "planar occupancy-grid A*");
  assert.equal(definition.navigation.routeOptions.length, 2);
  assert.ok(definition.objects.every((object) => object.initialState.contentsModel === "not simulated"));
  assert.ok(definition.objects.every((object) => object.initialState.payloadModel === "not simulated"));
  assert.ok(definition.processModels.every((process) => /no chemical, thermal, force, or measurement effect/.test(process.modeledEffect)));
  if (definition.migration.class === "C") assert.ok(definition.migration.redesignRationale);

  const routeEngine = await ScenarioV2Engine.create(definition);
  const primary = routeEngine.planBasePath(definition.frames.service_base.basePositionMm);
  const alternate = routeEngine.planBasePath(definition.frames.alternate_service_base.basePositionMm);
  assert.equal(primary.ok, true);
  assert.equal(alternate.ok, true);
  assert.equal(primary.code, "BASE_PATH_READY");
  assert.equal(alternate.code, "BASE_PATH_READY");
  assert.notDeepEqual(primary.path.pathMm, alternate.path.pathMm, "alternate route reaches a distinct safe destination");
  const blocked = new Set(definition.navigation.occupancyGrid.blocked);
  for (const route of [primary.path, alternate.path]) {
    assert.equal(route.code, "A_STAR");
    assert.ok(route.cells.every(([x, y]) => !blocked.has(`${x},${y}`)), "A* route avoids every configured blocked cell");
  }

  const unstowed = await ScenarioV2Engine.create(definition);
  unstowed.state.jointState.shoulder_lift = 30;
  const rejectedDrive = await unstowed.call("robot.navigate", { frameId: "service_base" });
  assert.equal(rejectedDrive.ok, false);
  assert.equal(rejectedDrive.code, "ARM_NOT_STOWED");

  const causalProbe = await ScenarioV2Engine.create(definition);
  const objectId = definition.objects[0].id;
  const beforeDrive = causalProbe.snapshot().objects[objectId];
  const drove = await causalProbe.call("robot.navigate", { frameId: "service_base" });
  assert.equal(drove.ok, true);
  assert.deepEqual(causalProbe.snapshot().objects[objectId], beforeDrive, "base motion does not mutate the task object");
  assert.equal(causalProbe.snapshot().eventLog.length, 0, "base phase cannot fabricate contact");
  const moved = await causalProbe.call("skills.transport", definition.validation.referenceExecutions[0].calls[1].args);
  assert.equal(moved.ok, true, moved.message);
  const types = causalProbe.snapshot().eventLog.map((event) => event.type);
  assert.ok(types.indexOf("CONTACT") < types.indexOf("ATTACH_OBJECT"));
  assert.ok(types.indexOf("PROCESS_CONTACT") < types.indexOf("PROCESS_COMMIT"));
  assert.ok(types.indexOf("PROCESS_COMMIT") < types.indexOf("DETACH_OBJECT"));

  for (const execution of definition.validation.referenceExecutions) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id} execution`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id} grade`);
    references += 1;
  }
  for (const execution of definition.validation.acceptedAlternates) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id} execution`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id} grade`);
    alternates += 1;
  }
  for (const execution of definition.validation.negativeCases) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls || []);
    assert.equal(run.grade.passed, false, `${definition.id}/${execution.id} must fail`);
    if (execution.expectedFailureKind === "goal") assert.ok(run.grade.goals.some((item) => !item.passed));
    if (execution.expectedFailureKind === "evidence") assert.ok(run.grade.evidence.some((item) => !item.passed));
    if (execution.expectedFailureKind === "prohibited") assert.ok(run.grade.prohibited.some((item) => item.triggered));
    if (execution.expectedFailureKind === "causal") assert.ok(run.grade.causal.length > 0 || run.results.some((item) => !item.ok));
    negatives += 1;
  }
}

assert.equal(references, 10);
assert.equal(alternates, 10);
assert.equal(negatives, 40);
console.log("LeKiwi ScenarioV2 family acceptance passed:");
console.log("- 10 schema-valid rank-aligned successors");
console.log("- 10 primary and 10 alternate safe route/contact executions passed");
console.log("- 40 goal/evidence/prohibited/causal negatives failed as declared");
console.log("- stow-before-drive, A* obstacle avoidance, event ordering, and unsupported-claim boundaries verified");
