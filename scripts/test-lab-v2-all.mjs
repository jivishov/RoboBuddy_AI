import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioV2Engine } from "../lab/v2/index.js";

await import("./test-lab-v2-foundation.mjs");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFINITIONS = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions");
const definitions = [];
for (const family of (await readdir(DEFINITIONS, { withFileTypes: true })).filter((item) => item.isDirectory())) {
  for (const file of (await readdir(resolve(DEFINITIONS, family.name))).filter((name) => name.endsWith(".json")).sort()) {
    definitions.push(JSON.parse(await readFile(resolve(DEFINITIONS, family.name, file), "utf8")));
  }
}

assert.equal(definitions.length, 50);
let references = 0;
let alternates = 0;
let negatives = 0;
for (const definition of definitions) {
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
