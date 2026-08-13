import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const { LabScenarioEngine } = await import(pathToFileURL(resolve(ROOT, "lab", "js", "actions.js")));
const { parsePythonProgram, commandsToPython } = await import(pathToFileURL(resolve(ROOT, "lab", "js", "interactions.js")));
const catalog = await readJson(resolve(ROOT, "missions", "lab-assistant", "index.json"));

for (const task of catalog.tasks) {
  const definition = await readJson(resolve(ROOT, task.definition));
  const invalidEngine = new LabScenarioEngine(definition);
  const recoveryTrace = definition.traces.invalidRecovery;
  const invalid = invalidEngine.execute(recoveryTrace[0].command);
  assert.equal(invalid.ok, false, `${task.id} invalid trace must reject`);
  assert.equal(invalid.code, recoveryTrace[0].expectedError, `${task.id} invalid error code`);
  for (const entry of recoveryTrace.slice(1)) {
    const recovery = invalidEngine.execute(entry.command);
    assert.equal(recovery.ok, true, `${task.id} recovery failed ${JSON.stringify(entry.command)}: ${recovery.message}`);
  }
  assert.equal(invalidEngine.snapshot().checkpointIndex, 1, `${task.id} invalid trace must recover through the first checkpoint`);
  const validEngine = new LabScenarioEngine(definition);
  for (const command of definition.traces.success) {
    const result = validEngine.execute(command);
    assert.equal(result.ok, true, `${task.id} failed ${JSON.stringify(command)}: ${result.message}`);
  }
  const final = validEngine.snapshot();
  assert.equal(final.runState, "complete", `${task.id} success trace must complete`);
  assert.equal(final.completedCheckpointIds.length, definition.checkpoints.length, `${task.id} checkpoint count`);
  const stoppedEngine = new LabScenarioEngine(definition);
  const navigation = definition.traces.success[0];
  stoppedEngine.execute(navigation);
  const beforeStop = stoppedEngine.snapshot();
  const stopped = stoppedEngine.execute({ type: "stop" });
  assert.equal(stopped.ok, true);
  assert.equal(stoppedEngine.snapshot().checkpointIndex, beforeStop.checkpointIndex, `${task.id} stop preserves checkpoint state`);
  stoppedEngine.reset();
  assert.equal(stoppedEngine.snapshot().checkpointIndex, 0, `${task.id} reset clears checkpoints`);

  const python = commandsToPython(definition.traces.success);
  const parsed = parsePythonProgram(python);
  assert.equal(parsed.length, definition.traces.success.length, `${task.id} Python round trip length`);
  assert.deepEqual(parsed.map((command) => command.type), definition.traces.success.map((command) => command.type), `${task.id} Python round trip command types`);
}

const openArm = await readJson(resolve(ROOT, "missions", "lab-assistant", "v1", "openarm-06-controlled-pour.json"));
const openArmEngine = new LabScenarioEngine(openArm);
const navigate = openArm.traces.success[0];
openArmEngine.execute(navigate);
const missingEffector = openArmEngine.execute({ type: "grasp", objectId: "receiving_beaker" });
assert.equal(missingEffector.code, "EFFECTOR_REQUIRED");

const numericTransferEngine = new LabScenarioEngine(openArm);
const pourIndex = openArm.traces.success.findIndex((command) => command.type === "pour_into");
for (const command of openArm.traces.success.slice(0, pourIndex)) {
  const result = numericTransferEngine.execute(command);
  assert.equal(result.ok, true, `numeric-transfer setup failed: ${result.message}`);
}
const numericTransfer = numericTransferEngine.execute({ ...openArm.traces.success[pourIndex], amount: 5 });
assert.equal(numericTransfer.code, "AMOUNT_UNAVAILABLE");

const g1 = await readJson(resolve(ROOT, "missions", "lab-assistant", "v1", "g1-02-sealed-sample.json"));
const g1Engine = new LabScenarioEngine(g1);
const fineManipulation = g1Engine.execute({ type: "grasp", objectId: "sealed_sample_tote" });
assert.equal(fineManipulation.code, "MORPHOLOGY_LIMIT");
assert.equal(g1Engine.execute({ type: "set_posture", posture: "invented_pose", seconds: 1 }).code, "UNKNOWN_POSTURE");

const g1HandsOnly = new LabScenarioEngine(g1);
for (const command of g1.traces.success) {
  const handsOnly = command.type === "pick_nearest" || command.type === "release_object" ? { type: command.type, hand: command.hand } : command;
  const result = g1HandsOnly.execute(handsOnly);
  assert.equal(result.ok, true, `G1 hand-only helper failed: ${result.message}`);
}
assert.equal(g1HandsOnly.snapshot().runState, "complete", "G1 hand-only Blockly/Python shape must complete the task");

const thermal = await readJson(resolve(ROOT, "missions", "lab-assistant", "v1", "arduino-arm-06-cool-then-weigh.json"));
const thermalEngine = new LabScenarioEngine(thermal);
thermalEngine.execute({ type: "move_to_pose", poseId: "cooling_zone" });
const skippedCooling = thermalEngine.execute({ type: "grasp", objectId: "dried_watch_glass" });
assert.equal(skippedCooling.code, "SEQUENCE_MISMATCH");

const gripper = await readJson(resolve(ROOT, "missions", "lab-assistant", "v1", "arduino-arm-01-balance-placement.json"));
const gripperEngine = new LabScenarioEngine(gripper);
gripperEngine.execute(gripper.traces.success[0]);
const closed = gripperEngine.execute({ type: "set_gripper", value: "close" });
assert.equal(closed.ok, true, "gripper close should attach the checkpoint object when in proximity");
gripperEngine.execute(gripper.traces.success[2]);
const opened = gripperEngine.execute({ type: "set_gripper", value: "open" });
assert.equal(opened.ok, true, "gripper open should release at the checkpoint zone when in proximity");
assert.equal(gripperEngine.snapshot().checkpointIndex, 2, "low-level gripper path should satisfy grasp and place checkpoints");

const parsedGripper = parsePythonProgram('robot.set_gripper(value="close", effector="default")');
assert.deepEqual(parsedGripper[0], { type: "set_gripper", value: "close", effector: "default" });

const wrongCoolingEngine = new LabScenarioEngine(thermal);
wrongCoolingEngine.execute(thermal.traces.success[0]);
const wrongCooling = wrongCoolingEngine.execute({ type: "operate", controlId: "cooling_rack", mode: "cool", value: "wrong_object" });
assert.equal(wrongCooling.code, "INVALID_OPERATION_TARGET");
assert.equal(wrongCoolingEngine.snapshot().checkpointIndex, 0, "wrong cooling target cannot advance the checkpoint");

const contaminatedEngine = new LabScenarioEngine(gripper);
contaminatedEngine.execute(gripper.traces.success[0]);
contaminatedEngine.state.apparatus.find((item) => item.id === "watch_glass").state.contamination = "unknown residue";
const contaminated = contaminatedEngine.execute({ type: "grasp", objectId: "watch_glass", effector: "default" });
assert.equal(contaminated.code, "CONTAMINATION_GATE");

const emptyObservationDefinition = await readJson(resolve(ROOT, "missions", "lab-assistant", "v1", "arduino-arm-10-two-stage-drying.json"));
const emptyObservationEngine = new LabScenarioEngine(emptyObservationDefinition);
const observationIndex = emptyObservationDefinition.traces.success.findIndex((command) => command.type === "record_observation");
for (const command of emptyObservationDefinition.traces.success.slice(0, observationIndex)) {
  const result = emptyObservationEngine.execute(command);
  assert.equal(result.ok, true, `observation precondition failed: ${result.message}`);
}
const emptyObservation = emptyObservationEngine.execute({ type: "record_observation", fieldId: "cooled_combined_mass", value: "" });
assert.equal(emptyObservation.code, "EMPTY_OBSERVATION");

const atomicAdapter = {
  manifest: {
    joints: [
      { id: "base", label: "Base", unit: "deg", min: 20, max: 130 },
      { id: "shoulder", label: "Shoulder", unit: "deg", min: 15, max: 165 }
    ]
  },
  applyCommand() { throw new Error("invalid joint batches must not reach the simulation adapter"); }
};
const atomicEngine = new LabScenarioEngine(gripper, atomicAdapter);
const atomicBefore = atomicEngine.snapshot().robotJoints;
const atomicFailure = atomicEngine.execute({ type: "move_joints", joints: { base: 100, shoulder: 999 } });
assert.equal(atomicFailure.code, "JOINT_LIMIT");
assert.deepEqual(atomicEngine.snapshot().robotJoints, atomicBefore, "joint batches must reject atomically");

const routeDefinition = await readJson(resolve(ROOT, "missions", "lab-assistant", "v1", "g1-07-reagent-tote.json"));
const routeEngine = new LabScenarioEngine(routeDefinition);
const firstPickupIndex = routeDefinition.traces.success.findIndex((command) => command.type === "pick_nearest");
for (const command of routeDefinition.traces.success.slice(0, firstPickupIndex + 1)) {
  const result = routeEngine.execute(command);
  assert.equal(result.ok, true, `restricted-route setup failed: ${result.message}`);
}
const routeBefore = routeEngine.snapshot();
const target = routeDefinition.robotPoses.mixing_zone.positionMm;
const dx = target[0] - routeBefore.basePositionMm[0];
const dz = target[2] - routeBefore.basePositionMm[2];
const targetHeading = Math.atan2(dz, dx) * 180 / Math.PI;
let turnAngle = targetHeading - routeBefore.headingDeg;
while (turnAngle > 180) turnAngle -= 360;
while (turnAngle < -180) turnAngle += 360;
assert.equal(routeEngine.execute({ type: "humanoid_turn", angleDeg: turnAngle, seconds: 1.2 }).ok, true);
const distanceMm = Math.hypot(dx, dz);
const directSteps = Math.ceil(distanceMm / 120);
const restrictedWalk = routeEngine.execute({ type: "humanoid_walk", direction: "forward", steps: directSteps, stepLengthM: distanceMm / directSteps / 1000, speed: 45 });
assert.equal(restrictedWalk.code, "HAZARD_ZONE", "restricted-zone segment must reject before state mutation");
assert.deepEqual(routeEngine.snapshot().basePositionMm, routeBefore.basePositionMm, "rejected route must preserve base position");

const shortRouteEngine = new LabScenarioEngine(routeDefinition);
const shortRoute = shortRouteEngine.execute({ type: "humanoid_walk", direction: "forward", steps: 1, stepLengthM: 0.02, speed: 45, destinationId: "storage_zone" });
assert.equal(shortRoute.code, "ROUTE_PROGRESS");
assert.equal(shortRouteEngine.snapshot().currentPose, "route", "distance alone cannot imply a station visit");

const lekiwiDefinition = await readJson(resolve(ROOT, "missions", "lab-assistant", "v1", "lekiwi-01-beaker-courier.json"));
const lekiwiEngine = new LabScenarioEngine(lekiwiDefinition);
assert.equal(lekiwiEngine.execute({ type: "drive", vx: 0.1, vy: 0, omega: 0, seconds: 1, frame: "map" }).code, "INVALID_DRIVE_FRAME");
assert.equal(lekiwiEngine.execute({ type: "move_joints", joints: lekiwiDefinition.robotPoses.supply_zone.joints, speed: 0 }).code, "JOINT_SPEED_LIMIT");

console.log("Lab runtime tests passed:");
console.log("- 50 success traces and 50 invalid proximity traces");
console.log("- stop/reset and Python normalization for every scenario");
console.log("- OpenArm effector, G1 morphology, and cooling-sequence gates");
console.log("- low-level gripper close/open attachment and Python normalization");
console.log("- full invalid/recovery traces, hand-only G1 helpers, exact operation targets, contamination, and non-empty observations");
console.log("- atomic joint rejection plus geometric route, destination-tolerance, and restricted-zone gates");
console.log("- duration/speed/posture/frame validation and explicit rejection of unsupported numeric fluid amounts");
