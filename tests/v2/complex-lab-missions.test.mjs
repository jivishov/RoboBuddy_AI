import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScenarioV2Engine,
  eventOccursBefore,
  objectAxisCoordinateMm,
  objectAxisDistanceMm,
  objectPlanarDistanceMm,
  objectPlanarOffsetMm,
  validateMeasurementFixture,
  validateMeasurementPredicate,
  validateScenarioV2,
} from "../../lab/v2/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFINITION_ROOT = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions");
const SO101_PATHS = [
  "so101/so101-v2-06-quantitative-transfer.json",
  "so101/so101-v2-08-burette-initial-reading.json",
  "so101/so101-v2-09-vacuum-filtration.json",
];
const OPENARM_PATH = "openarm/openarm-04-filtration-workcell.json";
const BASELINE_HASHES = Object.freeze({
  "so101-v2-06-quantitative-transfer": {
    frames: "72fb51d7483e36f2f8f3c82f2bc403d2887bd8f814ae3eef7c39a34c0035d08d",
    actions: "5dc3d71b7ad8e198585f487cf52a155e1664ffbe99a1d5766137fd383fab2be1",
  },
  "so101-v2-08-burette-initial-reading": {
    frames: "63133e12af37197b8b5eaa48a5aa1a918c2c4e75495b0eb02c3679494e33d50b",
    actions: "e9735d2e9577c19ca0c02ca8c5b8acea733d8b88b3fdbc32396d70f117f9d8bb",
  },
  "so101-v2-09-vacuum-filtration": {
    frames: "d21cd331bfd957632f1d783dbcf36ff6316fc55b9c04ec83908666ef3bc3fb5f",
    actions: "e9735d2e9577c19ca0c02ca8c5b8acea733d8b88b3fdbc32396d70f117f9d8bb",
  },
});

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function loadDefinition(path) {
  return JSON.parse(await readFile(resolve(DEFINITION_ROOT, path), "utf8"));
}

async function replayPortable(definition) {
  const instanceId = `complex-${definition.id}`;
  const config = definition.robotId === "so101_follower"
    ? { kind: "so101", port: "SIM", cameras: {} }
    : { kind: "bimanual", side: "bimanual", cameras: {} };
  const engine = await ScenarioV2Engine.create(definition, { autoStartPlant: false });
  const connected = await engine.call("compat.connect", { instanceId, config });
  assert.equal(connected.ok, true, `${definition.id}: portable connection`);
  const expectedActionKeys = definition.api.physicalProgrammability?.actionKeys
    || Object.keys(definition.portablePython.referenceActions[0]?.action || {});
  for (const [index, step] of definition.portablePython.referenceActions.entries()) {
    assert.deepEqual(
      new Set(Object.keys(step.action)),
      new Set(expectedActionKeys),
      `${definition.id}/${index}/${step.label}: exact public action fields`,
    );
    const sent = await engine.call("compat.send_action", { instanceId, action: step.action, options: {} });
    assert.equal(sent.ok, true, `${definition.id}/${index}/${step.label}: public action accepted`);
    const ticks = Math.ceil(Number(step.hold_seconds) / engine.plant.tickSeconds);
    for (let tick = 0; tick < ticks; tick += 1) engine.plant.tick();
    assert.equal(engine.plant.fault, null, `${definition.id}/${index}/${step.label}: no plant collision fault`);
  }
  await engine.call("compat.disconnect", { instanceId });
  const snapshot = engine.snapshot();
  engine.dispose();
  return snapshot;
}

const helperState = {
  objects: {
    a: { worldPositionMm: [10, 22, 30] },
    b: { worldPositionMm: [40, 70, 70] },
  },
  eventLog: [
    { type: "DETACH_OBJECT", objectId: "a", sequence: 1 },
    { type: "FRAME_REACHED", frameId: "a_retreat", sequence: 2 },
  ],
};
assert.equal(objectAxisCoordinateMm(helperState, "a", "y", [0, 20, 0]), 2);
assert.equal(objectAxisDistanceMm(helperState, "a", "b", "x"), 30);
assert.equal(objectPlanarDistanceMm(helperState, "a", "b", "xz"), 50);
assert.equal(objectPlanarOffsetMm(helperState, "a", [10, 0, 10], "xz"), 20);
assert.equal(eventOccursBefore(helperState.eventLog, { type: "DETACH_OBJECT" }, { type: "FRAME_REACHED" }), true);
assert.equal(validateMeasurementPredicate({ op: "object_axis_coordinate", objectId: "a", axis: "q", originMm: [0, 0, 0], minMm: 0, maxMm: 1 }).ok, false);
assert.equal(validateMeasurementPredicate({ op: "event_before", before: {}, after: { type: "FRAME_REACHED" } }).ok, false);

const so101Definitions = await Promise.all(SO101_PATHS.map(loadDefinition));
for (const definition of so101Definitions) {
  const validation = validateScenarioV2(definition, { expectedRobotId: "so101_follower" });
  assert.equal(validation.ok, true, `${definition.id}: ${validation.errors.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
  assert.equal(definition.complexityUpgrade.preservedMotionGeometry, true);
  assert.equal(definition.complexityUpgrade.preservedPublicPythonActionFields, true);
  assert.equal(definition.complexityUpgrade.physicalHardwareValidated, false);
  assert.equal(digest(definition.frames), BASELINE_HASHES[definition.id].frames, `${definition.id}: calibrated IK frames changed`);
  assert.equal(digest(definition.portablePython.referenceActions), BASELINE_HASHES[definition.id].actions, `${definition.id}: atomic Python reference actions changed`);
  const rulers = definition.fixtures.filter((fixture) => fixture.type === "configured_measurement_ruler");
  assert.equal(rulers.length, 2, `${definition.id}: two visible measurement references`);
  rulers.forEach((fixture) => {
    const ruler = validateMeasurementFixture(fixture);
    assert.equal(ruler.ok, true, `${definition.id}/${fixture.id}: ${ruler.errors.join("; ")}`);
    assert.equal(fixture.visible, true);
    assert.equal(fixture.configured, true);
    assert.equal(fixture.presentationOnly, true);
    assert.equal(fixture.collisionProxy, undefined);
    assert.equal(fixture.collisionProxies, undefined);
  });
  assert.ok(definition.goalPredicates.some((predicate) => predicate.op === "event_before"), `${definition.id}: ordered physical sequence`);
  assert.ok(definition.goalPredicates.some((predicate) => predicate.op.startsWith("object_")), `${definition.id}: geometry-based measurement goal`);
  assert.ok(definition.objects.every((object) => /dry|empty|sealed|no liquid modeled|not modeled/i.test([object.contents, object.initialState?.contentsSimulation].filter(Boolean).join(" "))), `${definition.id}: no fluid behavior inferred`);
  const snapshot = await replayPortable(definition);
  assert.equal(snapshot.grade.passed, true, `${definition.id}: unchanged physical action trace satisfies new authoritative grade`);
  assert.ok(snapshot.grade.goals.filter((goal) => ["event_before", "object_axis_coordinate", "object_axis_distance", "object_planar_distance", "object_planar_offset"].includes(goal.predicate.op)).every((goal) => goal.passed));
}

const openarm = await loadDefinition(OPENARM_PATH);
const openarmValidation = validateScenarioV2(openarm, { expectedRobotId: "openarm_v2_bimanual" });
assert.equal(openarmValidation.ok, true, openarmValidation.errors.map((item) => `${item.path}: ${item.message}`).join("; "));
assert.equal(openarm.complexityUpgrade.class, "bimanual_supported_equipment_stack");
assert.equal(openarm.complexityUpgrade.physicalHardwareValidated, false);
assert.deepEqual(openarm.fixtures.map((fixture) => fixture.type), [
  "configured_visible_bimanual_workcell",
  "configured_heater_platform",
  "configured_ring_stand_support",
  "configured_measurement_ruler",
  "configured_measurement_ruler",
]);
const openarmSurfaces = new Map(openarm.fixtures.flatMap((fixture) => fixture.collisionProxies || []).map((proxy) => [proxy.id, proxy]));
assert.equal(openarmSurfaces.get("left-heater-top").centerMm[1] + openarmSurfaces.get("left-heater-top").halfExtentsMm[1], 342);
assert.equal(openarmSurfaces.get("right-gauze-top").centerMm[1] + openarmSurfaces.get("right-gauze-top").halfExtentsMm[1], 388);
assert.deepEqual(openarm.objects.map((object) => [object.id, object.configuredApparatusProfile, object.initialState.contentsSimulation]), [
  ["left_erlenmeyer", "flask", "empty; no liquid modeled"],
  ["right_beaker", "small_beaker", "empty; no liquid modeled"],
]);
assert.ok(openarm.portablePython.referenceActions.length >= 100, "OpenArm stack must retain granular joint/action steps");
assert.equal(openarm.validation.referenceExecutions[0].calls.length, 2, "OpenArm extraction is anchored by two bounded transport calls");
const openarmSnapshot = await replayPortable(openarm);
assert.equal(openarmSnapshot.grade.passed, true, "OpenArm supported stack authoritative replay");
for (const [side, objectId] of [["left", "left_erlenmeyer"], ["right", "right_beaker"]]) {
  const detachIndex = openarmSnapshot.eventLog.findIndex((event) => event.type === "DETACH_OBJECT" && event.objectId === objectId);
  const retreatIndex = openarmSnapshot.eventLog.findIndex((event) => event.type === "FRAME_REACHED" && event.frameId === `${side}_retreat` && event.effector === side);
  assert.ok(detachIndex >= 0 && retreatIndex > detachIndex, `${side}: release must precede the distinct retreat event`);
}
const processCommitIndex = openarmSnapshot.eventLog.findIndex((event) => event.type === "PROCESS_COMMIT" && event.processId === "supported_stack_confirmed");
const lastRetreatIndex = Math.max(...["left", "right"].map((side) => openarmSnapshot.eventLog.findIndex((event) => event.type === "FRAME_REACHED" && event.frameId === `${side}_retreat`)));
assert.ok(processCommitIndex > lastRetreatIndex, "OpenArm process may commit only after both post-release retreats");
assert.deepEqual(
  openarmSnapshot.eventLog.filter((event) => event.type === "PLACE_CONTACT").map((event) => [event.objectId, event.rest?.surfaceId, event.rest?.ok]),
  [["left_erlenmeyer", "left-heater-top", true], ["right_beaker", "right-gauze-top", true]],
);

console.log("Complex lab mission acceptance passed:");
console.log("- 3 SO-101 missions preserve calibrated frames and exact Python action traces while adding ordered ruler-measured outcomes");
console.log("- OpenArm executes a direct-grip Erlenmeyer/hotplate and 50 mL beaker/ring-stand stack with real support contacts");
console.log("- all four reference programs pass fixed-step collision, support, sequence, and hidden grading checks");
