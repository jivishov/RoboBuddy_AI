import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRobotModel, validateProxyEnclosure, validateScenarioV2 } from "../lab/v2/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFINITIONS = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions");
const ROBOTS = ["arduino_arm", "so101_follower", "lekiwi_sim", "openarm_v2_bimanual", "unitree_g1_29dof"];
const definitions = [];

for (const family of (await readdir(DEFINITIONS, { withFileTypes: true })).filter((item) => item.isDirectory())) {
  for (const file of (await readdir(resolve(DEFINITIONS, family.name))).filter((name) => name.endsWith(".json")).sort()) {
    const definition = JSON.parse(await readFile(resolve(DEFINITIONS, family.name, file), "utf8"));
    const validation = validateScenarioV2(definition);
    assert.equal(validation.ok, true, `${file}:\n${validation.errors.map((item) => `${item.path}: ${item.message}`).join("\n")}`);
    definitions.push(definition);
  }
}

assert.equal(definitions.length, 50, "ScenarioV2 source count must be exactly 50");
assert.equal(new Set(definitions.map((item) => item.id)).size, 50, "ScenarioV2 ids must be unique");
assert.equal(new Set(definitions.map((item) => item.supersedes)).size, 50, "Every v1 task must have exactly one successor");
const v1Ids = new Set((await readdir(resolve(ROOT, "missions", "lab-assistant", "v1"))).filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, "")));
assert.deepEqual(new Set(definitions.map((item) => item.supersedes)), v1Ids, "supersedes mappings must cover all v1 ids exactly once");

for (const robotId of ROBOTS) {
  const tasks = definitions.filter((item) => item.robotId === robotId).sort((a, b) => a.rank - b.rank);
  assert.equal(tasks.length, 10, `${robotId} must have 10 tasks`);
  assert.deepEqual(tasks.map((item) => item.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const model = await loadRobotModel(robotId);
  assert.ok(validateProxyEnclosure(model, Object.fromEntries(model.joints.map((joint) => [joint.id, joint.home]))).ok, `${robotId} proxy enclosure`);
  tasks.forEach((task) => {
    assert.equal(task.canonicalModel.sourceRevision, model.source.revision, `${task.id} model revision`);
    assert.equal(task.modelClaim.supportedFidelity, model.fidelity, `${task.id} fidelity claim`);
    model.unsupportedPhysics.forEach((claim) => assert.ok(task.modelClaim.unsupportedPhysics.includes(claim), `${task.id} must preserve unsupported-physics claim: ${claim}`));
    if (robotId === "unitree_g1_29dof") {
      assert.ok(task.objects.every((item) => !item.transportable || (item.securedCarrier && item.attachmentInterface === model.configured.carrierInterface)), `${task.id} G1 transport objects must use secured carriers`);
      assert.ok(!task.grasps.some((grasp) => grasp.mode === "free"), `${task.id} G1 cannot expose free grasps`);
    }
  });
}

console.log("ScenarioV2 validation passed:");
console.log("- 50 unique successors; every v1 id mapped exactly once");
console.log("- 10 ranks per robot family");
console.log("- canonical revisions, model claims, collision enclosure, and G1 logistics boundary verified");
