import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioV2Engine } from "../../../lab/v2/scenario-engine.js";
import { validateScenarioV2 } from "../../../lab/v2/scenario-schema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePath = path.join(root, "missions/lab-assistant/v2/definitions/openarm/openarm-01-weighing-handoff.json");
const clientPath = path.join(root, "missions/lab-assistant/v2/generated/scenarios/openarm-01-weighing-handoff.json");
const definition = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const client = JSON.parse(fs.readFileSync(clientPath, "utf8"));

assert.equal(validateScenarioV2(definition).ok, true, "source task must satisfy the portable scenario contract");
assert.equal(validateScenarioV2(client, { requireValidation: false }).ok, true, "browser task must satisfy the portable scenario contract");
assert.deepEqual(definition.evidenceRequirements, [], "portable learner source must not call a grading/evidence API");
assert.ok(definition.hiddenGradingRequirements.length > 0, "prior evidence intent must remain as hidden plant/event grading");
assert.ok(definition.hiddenGradingRequirements.every((item) => item.learnerCallable === false && item.authority === "plant/events"));

const invalid = structuredClone(definition);
invalid.hiddenGradingRequirements = [];
const invalidResult = validateScenarioV2(invalid);
assert.equal(invalidResult.ok, false, "the schema must reject a portable task that silently loses hidden grading");
assert.ok(invalidResult.errors.some((item) => item.path === "hiddenGradingRequirements"));

const engine = await ScenarioV2Engine.create(client, { autoStartPlant: false });
try {
  assert.equal(engine.snapshot().grade.hidden.every((item) => !item.passed), true, "hidden checks must begin pending");
  const connected = await engine.call("compat.connect", { instanceId: "openarm-workbench-regression", config: { kind: "bimanual", side: "bimanual", cameras: {} } });
  assert.equal(connected.ok, true);
  for (const step of client.portablePython.referenceActions) {
    const sent = await engine.call("compat.send_action", { instanceId: "openarm-workbench-regression", action: step.action, options: {} });
    assert.equal(sent.ok, true, `${step.label}: ${sent.code} ${sent.message}`);
    for (let index = 0; index < Math.ceil(Number(step.hold_seconds) / engine.plant.tickSeconds); index += 1) engine.plant.tick();
    assert.equal(engine.plant.fault, null, `${step.label}: ${engine.plant.fault?.message || "plant fault"}`);
  }
  await engine.call("compat.disconnect", { instanceId: "openarm-workbench-regression" });
  const result = engine.snapshot().grade;
  assert.equal(result.passed, true, `reference run must pass: ${result.code}`);
  assert.equal(result.hidden.every((item) => item.passed), true, "hidden grading must be satisfied only by authoritative state/events");
} finally {
  engine.dispose();
}

console.log("OpenArm portable workbench regression: PASS");
