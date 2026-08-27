import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioV2Engine } from "../lab/v2/index.js";

await import("./test-lab-v2-foundation.mjs");
await import("../tests/v2/portable-workbench-ux.test.mjs");
await import("../tests/v2/portable-physical-rest.test.mjs");
await import("../tests/v2/portable-apparatus-visuals.test.mjs");
await import("../tests/v2/openarm/openarm-surface-pinch-regression.test.mjs");
await import("../tests/v2/complex-lab-missions.test.mjs");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFINITIONS = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions");
const definitions = [];
for (const family of (await readdir(DEFINITIONS, { withFileTypes: true })).filter((item) => item.isDirectory())) {
  for (const file of (await readdir(resolve(DEFINITIONS, family.name))).filter((name) => name.endsWith(".json")).sort()) {
    definitions.push(JSON.parse(await readFile(resolve(DEFINITIONS, family.name, file), "utf8")));
  }
}

assert.equal(definitions.length, 50);
const legacyManifest = JSON.parse(await readFile(resolve(ROOT, "missions", "lab-assistant", "v2", "legacy-v1-export.json"), "utf8"));
assert.equal(legacyManifest.readOnly, true);
assert.equal(legacyManifest.reinterpretAsV2, false);
assert.equal(legacyManifest.files.length, 50);
for (const entry of legacyManifest.files) {
  const content = await readFile(resolve(ROOT, entry.path));
  assert.equal(content.byteLength, entry.bytes, `${entry.path} legacy byte count`);
  assert.equal(createHash("sha256").update(content).digest("hex"), entry.sha256, `${entry.path} legacy digest`);
}
let references = 0;
let alternates = 0;
let negatives = 0;
const portableRobots = new Set(["so101_follower", "lekiwi_sim", "openarm_v2_bimanual"]);
function portableConnection(robotId) {
  if (robotId === "so101_follower") return { instanceId: "full-suite", config: { kind: "so101", port: "SIM", cameras: {} } };
  if (robotId === "lekiwi_sim") return { instanceId: "full-suite", config: { kind: "lekiwi", remote_ip: "127.0.0.1", cameras: {} } };
  return { instanceId: "full-suite", config: { kind: "bimanual", side: "bimanual", cameras: {} } };
}
for (const definition of definitions) {
  if (portableRobots.has(definition.robotId)) {
    const engine = await ScenarioV2Engine.create(definition, { autoStartPlant: false });
    assert.equal((await engine.call("compat.connect", portableConnection(definition.robotId))).ok, true);
    for (const step of definition.portablePython.referenceActions) {
      const sent = await engine.call("compat.send_action", { instanceId: "full-suite", action: step.action, options: {} });
      assert.equal(sent.ok, true, `${definition.id}/${step.label}: portable reference action`);
      for (let tick = 0; tick < Math.ceil(step.hold_seconds / engine.plant.tickSeconds); tick += 1) engine.plant.tick();
      assert.equal(engine.plant.fault, null, `${definition.id}/${step.label}: portable collision fault`);
    }
    await engine.call("compat.disconnect", { instanceId: "full-suite" });
    const portableGrade = engine.snapshot().grade;
    assert.equal(
      portableGrade.passed,
      true,
      `${definition.id}: portable reference must satisfy authoritative grading; missing=${portableGrade.goals.filter((goal) => !goal.passed).map((goal) => goal.id).join(",")}; prohibited=${portableGrade.prohibited.filter((item) => item.triggered).map((item) => item.id).join(",")}; causal=${portableGrade.causal.map((item) => item.code).join(",")}`
    );
    references += definition.validation.referenceExecutions.length;
    definition.validation.acceptedAlternates.forEach((execution) => {
      assert.equal(execution.calls, undefined);
      assert.equal(execution.portableProgram.learnerGradingCalls, false);
      alternates += 1;
    });
    definition.validation.negativeCases.forEach((execution) => {
      assert.equal(execution.calls, undefined);
      assert.equal(execution.portableNegative, true);
      negatives += 1;
    });
    engine.dispose();
    continue;
  }
  for (const execution of definition.validation.referenceExecutions) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: reference calls must execute`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: reference must satisfy outcome plus evidence`);
    references += 1;
  }
  for (const execution of definition.validation.acceptedAlternates) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: alternate calls must execute`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: alternate algorithm/seed/order must pass`);
    alternates += 1;
  }
  for (const execution of definition.validation.negativeCases) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls || []);
    assert.equal(run.grade.passed, false, `${definition.id}/${execution.id}: perturbation must fail`);
    if (execution.expectedFailureKind === "evidence") assert.ok(run.grade.evidence.some((item) => !item.passed), `${definition.id}/${execution.id}: evidence failure expected`);
    if (execution.expectedFailureKind === "goal") assert.ok(run.grade.goals.some((item) => !item.passed), `${definition.id}/${execution.id}: goal failure expected`);
    if (execution.expectedFailureKind === "prohibited") assert.ok(run.grade.prohibited.some((item) => item.triggered), `${definition.id}/${execution.id}: prohibited-state failure expected`);
    if (execution.expectedFailureKind === "causal") assert.ok(run.grade.causal.length > 0 || run.results.some((item) => !item.ok), `${definition.id}/${execution.id}: causal/API rejection expected`);
    negatives += 1;
  }
}

console.log("ScenarioV2 execution acceptance passed:");
console.log(`- ${references} validation-only reference executions passed`);
console.log(`- ${alternates} legitimate alternate executions passed`);
console.log(`- ${negatives} negative perturbations failed for their declared category`);
console.log("- 50 v1 definitions matched the read-only export manifest byte counts and SHA-256 digests");
