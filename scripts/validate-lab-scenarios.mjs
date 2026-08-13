import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAB_ROOT = resolve(ROOT, "missions", "lab-assistant");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const catalog = await readJson(resolve(LAB_ROOT, "index.json"));
const ledger = await readJson(resolve(LAB_ROOT, "source-ledger.json"));
const files = (await readdir(resolve(LAB_ROOT, "v1"))).filter((file) => file.endsWith(".json"));
const manifests = new Map();
const manifestContext = vm.createContext({ window: { RoboAdmin: { RobotRegistry: { register(manifest) { manifests.set(manifest.id, manifest); } } } } });
for (const robot of catalog.robots) {
  const source = await readFile(resolve(ROOT, "robots", "packs", robot.id, "manifest.js"), "utf8");
  vm.runInContext(source, manifestContext, { filename: `${robot.id}/manifest.js` });
}

assert.equal(catalog.schema, "robobuddy.lab-catalog.v1");
assert.equal(catalog.tasks.length, 50, "catalog must contain exactly 50 tasks");
assert.equal(files.length, 50, "scenario folder must contain exactly 50 JSON definitions");
assert.equal(new Set(catalog.tasks.map((task) => task.id)).size, 50, "scenario IDs must be unique");
assert.equal(ledger.schema, "robobuddy.lab-source-ledger.v1");

for (const robot of catalog.robots) {
  const tasks = catalog.tasks.filter((task) => task.robotId === robot.id).sort((a, b) => a.rank - b.rank);
  assert.equal(tasks.length, 10, `${robot.id} must have 10 tasks`);
  assert.deepEqual(tasks.map((task) => task.rank), [1,2,3,4,5,6,7,8,9,10], `${robot.id} ranks must be 1..10`);
}

const ledgerIds = new Set(ledger.techniques.map((item) => item.id));
const ledgerActions = new Map(ledger.techniques.map((item) => [item.id, new Set(item.reviewedActionIds)]));
for (const task of catalog.tasks) {
  const definition = await readJson(resolve(ROOT, task.definition));
  const manifest = manifests.get(definition.robotId);
  assert.ok(manifest, `${task.id} needs a canonical robot manifest`);
  const manifestJoints = new Map(manifest.joints.map((joint) => [joint.id, joint]));
  assert.equal(definition.schema, "robobuddy.lab-scenario.v1");
  assert.equal(definition.id, task.id);
  assert.equal(definition.robotId, task.robotId);
  assert.equal(definition.rank, task.rank);
  assert.ok(definition.checkpoints.length >= 3, `${task.id} needs at least 3 observable checkpoints`);
  assert.ok(definition.traces.success.length >= definition.checkpoints.length, `${task.id} success trace must cover checkpoints`);
  assert.equal(definition.traces.invalidRecovery[0].expectedError, "NOT_IN_PROXIMITY", `${task.id} needs invalid proximity trace`);
  assert.ok(definition.apparatus.length >= 1, `${task.id} needs apparatus`);
  assert.ok(definition.zones.length >= 4, `${task.id} needs task zones`);
  assert.ok(definition.allowedCommands.includes("stop"), `${task.id} must allow stop`);
  assert.deepEqual(definition.languages, ["blockly", "python"]);
  assert.ok(definition.simulationBoundary.includes("not authorization"));
  definition.techniqueRefs.forEach((ref) => {
    assert.ok(ledgerIds.has(ref.techniqueId), `${task.id} references unknown technique ${ref.techniqueId}`);
    assert.equal(ref.basis, "M");
    assert.ok(ref.actionIds.length >= 1, `${task.id} source ref needs reviewed action IDs`);
    ref.actionIds.forEach((actionId) => assert.ok(ledgerActions.get(ref.techniqueId).has(actionId), `${task.id} cites unreviewed ${ref.techniqueId}/${actionId}`));
    assert.ok(ref.scope.includes("authored configuration"), `${task.id} source scope must distinguish authored robot behavior`);
  });
  definition.checkpoints.forEach((checkpoint, index) => {
    assert.equal(checkpoint.id, `cp-${String(index + 1).padStart(2, "0")}`);
    assert.ok(Array.isArray(checkpoint.sourceBasis), `${task.id}/${checkpoint.id} basis must be explicit list`);
    assert.ok(checkpoint.invalidFeedback && checkpoint.recovery);
    assert.ok(checkpoint.expected.requiredPose);
    if (["grasp", "place", "pick_nearest", "release_object"].includes(checkpoint.expected.type)) {
      assert.ok(!checkpoint.sourceBasis.includes("M"), `${task.id}/${checkpoint.id} robot handling must not overclaim source-stated technique performance`);
    }
  });
  Object.values(definition.robotPoses).forEach((pose) => {
    Object.entries(pose.joints || {}).forEach(([jointId, value]) => {
      const joint = manifestJoints.get(jointId);
      assert.ok(joint, `${task.id}/${pose.id} uses unknown canonical joint ${jointId}`);
      assert.ok(Number(value) >= Number(joint.min) && Number(value) <= Number(joint.max), `${task.id}/${pose.id}/${jointId} exceeds canonical limits`);
    });
  });
  const home = definition.robotPoses.home.joints;
  manifest.joints.forEach((joint) => assert.equal(home[joint.id], joint.home, `${task.id}/home/${joint.id} must preserve canonical home`));
  const zoneIds = new Set(definition.zones.map((zone) => zone.id));
  definition.apparatus.forEach((item) => {
    assert.ok(zoneIds.has(item.initialZone), `${task.id}/${item.id} initial zone must be rendered`);
    item.allowedZones.forEach((zoneId) => assert.ok(zoneIds.has(zoneId), `${task.id}/${item.id} allowed zone must exist: ${zoneId}`));
    item.compatibleTargets.forEach((targetId) => assert.ok(definition.apparatus.some((candidate) => candidate.id === targetId), `${task.id}/${item.id} compatible target must exist: ${targetId}`));
  });
  assert.equal(definition.camera.preset, "authored-task");
  assert.equal(definition.camera.positionMm.length, 3);
  assert.equal(definition.camera.targetMm.length, 3);
  if (definition.robotId === "unitree_g1_29dof") {
    ["grasp", "place", "insert_into", "pour_into"].forEach((command) => assert.ok(!definition.allowedCommands.includes(command), `${task.id} cannot allow ${command}`));
    definition.apparatus.filter((item) => definition.traces.success.some((entry) => entry.type === "pick_nearest" && entry.objectId === item.id))
      .forEach((item) => assert.equal(item.affordances.securedCarrier, true, `${task.id}/${item.id} must be secured`));
  }
  if (definition.rank >= 8) {
    Object.values(definition.robotPoses).forEach((pose) => {
      const expected = ["home", "dock", "safety"].includes(pose.id);
      assert.equal(pose.helperAvailable, expected, `${task.id}/${pose.id} challenge helper gate`);
    });
  }
  if (definition.rank >= 4 && definition.rank <= 7) {
    const taskPoses = Object.values(definition.robotPoses).filter((pose) => !["home", "dock", "safety"].includes(pose.id));
    assert.ok(taskPoses.some((pose) => pose.helperAvailable), `${task.id} Builder tasks must retain some named-pose assistance`);
    assert.ok(taskPoses.some((pose) => !pose.helperAvailable), `${task.id} Builder tasks must reduce named-pose assistance`);
  }
}

const workbenchHtml = await readFile(resolve(ROOT, "lab-workbench.html"), "utf8");
const forbidden = ["robots/safety.js", "js/serial.js", "robots/runtime.js", "robots/adapters/hardware/hardware.js", "virtual-leader", "local_bridge", "btnConnect", "navigator.serial"];
forbidden.forEach((needle) => assert.ok(!workbenchHtml.includes(needle), `lab workbench must not load or expose ${needle}`));
assert.ok(workbenchHtml.includes("robots/adapters/simulation/simulation.js"));
assert.ok(workbenchHtml.includes("lab/js/workbench.js"));
assert.ok(workbenchHtml.includes("lab/js/simulation-safety.js"));
assert.ok(workbenchHtml.includes("does not execute arbitrary Python"));

const simulationSafety = await readFile(resolve(ROOT, "lab", "js", "simulation-safety.js"), "utf8");
["arming", "bridge", "connection", "calibration", "virtual_leader", "file_id"].forEach((needle) => {
  assert.ok(!simulationSafety.toLowerCase().includes(needle), `simulation-only safety shim must not contain ${needle}`);
});
const workbenchSource = await readFile(resolve(ROOT, "lab", "js", "workbench.js"), "utf8");
assert.ok(workbenchSource.includes("function saveAllDrafts()"));
assert.ok(workbenchSource.includes("function applyAuthoredCamera()"));

const meshFiles = (await readdir(resolve(ROOT, "simulator", "js"))).filter((file) => file.startsWith("robot-mesh-data-"));
assert.ok(meshFiles.length >= 4, "existing baked robot mesh modules remain present");

const apparatusTransitions = new Set(["grasp", "pick_nearest", "place", "release_object", "insert_into", "pour_into"]);
let transitionCommands = 0;
let carriedMoves = 0;
for (const task of catalog.tasks) {
  const definition = await readJson(resolve(ROOT, task.definition));
  const heldByEffector = new Map();
  let currentPose = "home";
  let checkpointCursor = 0;
  for (const command of definition.traces.success) {
    if (["move_to_pose", "move_joints", "drive", "humanoid_walk", "home"].includes(command.type)) {
      if (heldByEffector.size) carriedMoves += 1;
      if (command.type === "move_to_pose") currentPose = command.poseId;
      else if (command.type === "home") currentPose = "home";
      else if (command.destinationId) currentPose = command.destinationId;
      else if (command.type === "move_joints") {
        const matched = Object.values(definition.robotPoses).find((pose) => JSON.stringify(pose.joints) === JSON.stringify(command.joints));
        if (matched) currentPose = matched.id;
      }
    }
    if (!apparatusTransitions.has(command.type)) continue;
    transitionCommands += 1;
    const checkpointIndex = definition.checkpoints.findIndex((candidate, index) => index >= checkpointCursor && candidate.expected.type === command.type && candidate.expected.objectId === command.objectId);
    const checkpoint = checkpointIndex >= 0 ? definition.checkpoints[checkpointIndex] : null;
    assert.ok(checkpoint, `${task.id}/${command.type}/${command.objectId} needs an authored checkpoint`);
    checkpointCursor = checkpointIndex + 1;
    const requiredPose = checkpoint.expected.requiredPose;
    assert.equal(currentPose, requiredPose, `${task.id}/${command.type}/${command.objectId} trace must navigate to ${requiredPose} before manipulation`);
    const effector = command.hand || command.effector || (definition.robotId === "unitree_g1_29dof" ? "right_hand" : "default");
    if (["grasp", "pick_nearest"].includes(command.type)) heldByEffector.set(effector, command.objectId);
    if (["place", "release_object", "insert_into"].includes(command.type)) heldByEffector.delete(effector);
  }
}
assert.ok(transitionCommands > 0 && carriedMoves > 0, "catalog must exercise animated apparatus transitions and carried motion");

console.log("Lab scenario validation passed:");
console.log("- 50 unique scenarios; 10 per robot; ranks 1..10");
console.log("- source refs, checkpoints, traces, assistance gates, and G1 carriers valid");
console.log(`- ${transitionCommands} grip/place/insert/transfer trace actions navigate to authored poses; ${carriedMoves} robot moves carry held apparatus`);
console.log("- lab workbench excludes serial, hardware adapter, runtime bridge, and virtual leader scripts");
