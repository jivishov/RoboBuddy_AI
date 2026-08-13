import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScenarioV2Engine,
  loadRobotModel,
  modelClaim,
  requireStowedForDrive,
  validateScenarioV2
} from "../../../lab/v2/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFINITIONS = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "lekiwi");
const LEGACY = resolve(ROOT, "missions", "lab-assistant", "v1");
const EXPECTED = [
  ["lekiwi-01-beaker-courier", "lekiwi-01-beaker-courier", "A"],
  ["lekiwi-02-glassware-route", "lekiwi-02-sample-fetch", "B"],
  ["lekiwi-03-sample-delivery", "lekiwi-03-mobile-weighing", "B"],
  ["lekiwi-04-filter-station-run", "lekiwi-04-cuvette-rack", "B"],
  ["lekiwi-05-reagent-shuttle", "lekiwi-05-waste-return", "B"],
  ["lekiwi-06-cooling-rack-route", "lekiwi-06-dilution-route", "C"],
  ["lekiwi-07-chromatography-route", "lekiwi-07-filtration-supply", "C"],
  ["lekiwi-08-spectrometer-route", "lekiwi-08-cooled-precipitate", "C"],
  ["lekiwi-09-titration-logistics", "lekiwi-09-spectro-route", "C"],
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
  const legacy = JSON.parse(await readFile(resolve(LEGACY, `${definition.supersedes}.json`), "utf8"));
  assert.equal(definition.schemaVersion, 2);
  assert.equal(definition.canonicalModelId, "lekiwi_sim");
  assert.equal(definition.legacyClassification, definition.migration.class);
  assert.equal(definition.migration.legacyLearningObjective, legacy.objectives.join(" "));
  assert.deepEqual(definition.migration.legacySuccessCriteria, legacy.successCriteria);
  assert.equal(definition.canonicalModel.sourceRevision, model.source.revision);
  assert.deepEqual(definition.modelClaim, canonicalClaim);
  assert.deepEqual(new Set(definition.provenance.map((entry) => entry.label)), new Set(["M", "F", "R", "C"]));
  assert.ok(definition.fixtures.every((fixture) => fixture.visible === true));
  assert.ok(definition.fixtures.slice(0, 2).every((fixture) => fixture.collisionProxy?.type === "box"));
  assert.ok(definition.fixtures.slice(0, 2).every((fixture) => fixture.collisionProxy?.provenance?.startsWith("C:")));
  assert.ok(definition.processModels.every((process) => process.discrete && process.contactGated));
  assert.ok(definition.processModels.every((process) => process.prerequisites.length > 0));
  assert.ok(definition.evidenceRequirements.every((requirement) => requirement.availableWhen && requirement.requiresEvent));
  assert.equal(definition.navigation.planner, "planar occupancy-grid A*");
  assert.equal(definition.navigation.routeOptions.length, 2);
  assert.match(definition.navigation.clearanceModel, /Point-cell occupancy only/);
  assert.ok(definition.navigation.prohibitedCapabilities.includes("footprint-clearance guarantee"));
  assert.ok(definition.objects.every((object) => object.initialState.contentsModel === "not simulated"));
  assert.ok(definition.objects.every((object) => object.initialState.payloadModel === "not simulated"));
  assert.ok(definition.processModels.every((process) => /no chemical, thermal, force, payload, fluid, or measurement effect/.test(process.modeledEffect)));
  if (definition.migration.class === "B") assert.ok(definition.migration.fixtureAssistance);
  if (definition.migration.class === "C") assert.ok(definition.migration.redesignRationale);

  const routeEngine = await ScenarioV2Engine.create(definition);
  const primary = routeEngine.planBasePath(definition.frames.service_base.basePositionMm);
  const alternate = routeEngine.planBasePath(definition.frames.alternate_service_base.basePositionMm);
  assert.equal(primary.ok, true);
  assert.equal(alternate.ok, true);
  assert.equal(primary.code, "BASE_PATH_READY");
  assert.equal(alternate.code, "BASE_PATH_READY");
  assert.notDeepEqual(primary.path.cells, alternate.path.cells, "alternate route cannot duplicate the primary cell path");
  assert.notDeepEqual(primary.path.cells.at(-1), alternate.path.cells.at(-1), "alternate route reaches a distinct configured base stop");
  const blocked = new Set(definition.navigation.occupancyGrid.blocked);
  for (const route of [primary.path, alternate.path]) {
    assert.equal(route.code, "A_STAR");
    assert.ok(route.cells.length > 2);
    assert.ok(route.cells.every(([x, y]) => !blocked.has(`${x},${y}`)), "A* route avoids every configured occupied cell");
  }

  const unstowed = await ScenarioV2Engine.create(definition);
  unstowed.state.jointState.shoulder_lift = 30;
  const rejectedDrive = await unstowed.call("robot.navigate", { frameId: "service_base" });
  assert.equal(rejectedDrive.ok, false);
  assert.equal(rejectedDrive.code, "ARM_NOT_STOWED");

  const earlyEvidence = await (await ScenarioV2Engine.create(definition)).call("lab.record_evidence", {
    requirementId: "route_and_placement_observation",
    value: "Configured route used; object delivered and visibly seated."
  });
  assert.equal(earlyEvidence.ok, false);
  assert.equal(earlyEvidence.code, "EVIDENCE_NOT_AVAILABLE");

  const prematureProcess = await (await ScenarioV2Engine.create(definition)).call("skills.fixture_operation", {
    processId: "placement_latch",
    objectId: definition.objects[0].id,
    fixtureId: "destination_fixture",
    value: "seated"
  });
  assert.equal(prematureProcess.ok, false);
  assert.equal(prematureProcess.code, "PROCESS_PREREQUISITE");

  const causalProbe = await ScenarioV2Engine.create(definition);
  const objectId = definition.objects[0].id;
  const beforeDrive = causalProbe.snapshot().objects[objectId];
  const drove = await causalProbe.call("robot.navigate", { frameId: "service_base" });
  assert.equal(drove.ok, true);
  assert.deepEqual(causalProbe.snapshot().objects[objectId], beforeDrive, "base motion does not mutate the task object");
  assert.equal(causalProbe.snapshot().eventLog.length, 0, "base phase cannot fabricate contact");
  if (definition.processModels[0].prerequisites[0].op === "all") {
    const secondStop = await causalProbe.call("robot.navigate", { frameId: "alternate_service_base" });
    assert.equal(secondStop.ok, true);
  }
  const referenceTransport = definition.validation.referenceExecutions[0].calls.find((call) => call.method === "skills.transport");
  const moved = await causalProbe.call("skills.transport", referenceTransport.args);
  assert.equal(moved.ok, true, moved.message);
  assert.equal(requireStowedForDrive(model, causalProbe.snapshot().jointState).ok, true, "transport retreat must restore the stowed arm");
  const types = causalProbe.snapshot().eventLog.map((event) => event.type);
  assert.ok(types.indexOf("CONTACT") < types.indexOf("ATTACH_OBJECT"));
  assert.ok(types.indexOf("PLACE_CONTACT") < types.indexOf("DETACH_OBJECT"));
  assert.ok(types.indexOf("DETACH_OBJECT") < types.indexOf("PROCESS_CONTACT"));
  assert.ok(types.indexOf("PROCESS_CONTACT") < types.indexOf("PROCESS_COMMIT"));

  const outcomeWithoutEvidence = definition.validation.negativeCases.find((item) => item.id === "missing-evidence-after-valid-outcome");
  const evidenceEngine = await ScenarioV2Engine.create(definition);
  const outcomeRun = await evidenceEngine.executeProgram(outcomeWithoutEvidence.calls);
  assert.equal(outcomeRun.ok, true);
  assert.ok(outcomeRun.grade.goals.every((item) => item.passed));
  const weakEvidence = await evidenceEngine.call("lab.record_evidence", {
    requirementId: "route_and_placement_observation",
    value: "The configured route was completed without an outcome description."
  });
  assert.equal(weakEvidence.ok, false);
  assert.equal(weakEvidence.code, "EVIDENCE_NOT_AVAILABLE");

  for (const execution of definition.validation.referenceExecutions) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id} execution`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id} grade`);
    assert.deepEqual(run.state.rootPose.positionMm, [0, 0, 0]);
    assert.equal(requireStowedForDrive(model, run.state.jointState).ok, true);
    references += 1;
  }
  for (const execution of definition.validation.acceptedAlternates) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id} execution`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id} grade`);
    assert.deepEqual(run.state.rootPose.positionMm, [0, 0, 0]);
    assert.equal(requireStowedForDrive(model, run.state.jointState).ok, true);
    alternates += 1;
  }
  for (const execution of definition.validation.negativeCases) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls || []);
    assert.equal(run.grade.passed, false, `${definition.id}/${execution.id} must fail`);
    if (execution.expectedFailureKind === "goal") assert.ok(run.grade.goals.some((item) => !item.passed));
    if (execution.expectedFailureKind === "evidence") {
      assert.equal(run.ok, true);
      assert.ok(run.grade.goals.every((item) => item.passed));
      assert.ok(run.grade.prohibited.every((item) => !item.triggered));
      assert.equal(run.grade.causal.length, 0);
      assert.ok(run.grade.evidence.some((item) => !item.passed));
    }
    if (execution.expectedFailureKind === "prohibited") {
      assert.equal(run.ok, true);
      assert.ok(run.grade.goals.every((item) => item.passed));
      assert.ok(run.grade.evidence.every((item) => item.passed));
      assert.equal(run.grade.causal.length, 0);
      assert.deepEqual(run.grade.prohibited.filter((item) => item.triggered).map((item) => item.id), ["restricted_stop_visited"]);
    }
    if (execution.expectedFailureKind === "causal") {
      const lastFailure = run.results.find((item) => !item.ok);
      assert.ok(lastFailure, `${definition.id}/${execution.id} must be rejected by the API`);
      if (execution.id === "approach-frame-is-not-contact") assert.equal(lastFailure.code, "CONTACT_REQUIRED");
      if (execution.id === "arm-transport-before-base-route") {
        assert.equal(lastFailure.code, "PROCESS_PREREQUISITE");
        assert.equal(run.state.eventLog.length, 0, "missing base prerequisite must reject transport before contact or mutation");
      }
    }
    negatives += 1;
  }
}

assert.equal(references, 10);
assert.equal(alternates, 10);
assert.equal(negatives, 50);
console.log("LeKiwi ScenarioV2 family acceptance passed:");
console.log("- 10 schema-valid, rank-aligned successors preserve v1 objectives and success criteria");
console.log("- 10 primary and 10 alternate configured A*/contact executions passed and returned home stowed");
console.log("- 50 goal/evidence/prohibited/causal negatives failed with category-specific assertions");
console.log("- mandatory base travel, distinct occupied-cell routes, task proxies, event ordering, and claim boundaries verified");
