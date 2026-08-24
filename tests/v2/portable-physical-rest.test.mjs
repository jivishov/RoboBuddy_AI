import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioV2Engine } from "../../lab/v2/scenario-engine.js";
import { rotate3 } from "../../lab/v2/math.js";
import { validatePhysicalRestDefinition, validateRestPose } from "../../lab/v2/physical-rest.js";
import { stripValidationForClient } from "../../lab/v2/scenario-schema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const families = ["so101", "lekiwi", "openarm"];
const sources = families.flatMap((family) => fs.readdirSync(path.join(root, "missions/lab-assistant/v2/definitions", family))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({ family, name, path: path.join(root, "missions/lab-assistant/v2/definitions", family, name) })));
assert.equal(sources.length, 30);

const equipmentSceneSource = fs.readFileSync(path.join(root, "lab/v2/equipment-scene.js"), "utf8");
assert.match(equipmentSceneSource, /const portable = openArm \|\| so101 \|\| this\.definition\.robotId === "lekiwi_sim"/);
assert.match(equipmentSceneSource, /showStem: !portable/,
  "portable frame overlays must not render vertical stems that resemble support sticks");

const syntheticSupport = /(?:registration[-_ ]?pin|rear[-_ ]?post|edge[-_ ]?tab|support[-_ ]?stick|thin[-_ ]?rod|synthetic[-_ ]?support)/i;
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function tiltDeg(rotation, localUp = [0, 1, 0]) {
  const up = rotate3(rotation, localUp);
  return Math.acos(Math.max(-1, Math.min(1, up[1] / Math.hypot(...up)))) * 180 / Math.PI;
}

for (const source of sources) {
  const definition = JSON.parse(fs.readFileSync(source.path, "utf8"));
  const physical = validatePhysicalRestDefinition(definition);
  assert.equal(physical.ok, true, `${definition.id}: ${physical.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  definition.fixtures.forEach((fixture) => {
    const proxies = fixture.collisionProxies || (fixture.collisionProxy ? [fixture.collisionProxy] : []);
    proxies.forEach((proxy) => {
      assert.doesNotMatch(`${fixture.id} ${fixture.type || ""} ${fixture.label || ""} ${proxy.id || ""} ${proxy.provenance || ""}`, syntheticSupport, `${definition.id}: synthetic support token`);
      if (proxy.planningRole === "contact_surface") {
        assert.equal(proxy.type, "box", `${definition.id}/${proxy.id}: rest surface shape`);
        assert.ok(proxy.halfExtentsMm[0] >= 80 && proxy.halfExtentsMm[2] >= 80, `${definition.id}/${proxy.id}: real support must be at least 160 mm broad in both horizontal axes`);
        assert.equal(proxy.physicalSupportSurface, true, `${definition.id}/${proxy.id}: support authority`);
      }
    });
    assert.notEqual(fixture.type, "configured_visible_support_pad", `${definition.id}: legacy support pad`);
    assert.notEqual(fixture.type, "morphology_adapter", `${definition.id}: legacy morphology prop`);
  });
  definition.objects.filter((item) => item.transportable !== false).forEach((item) => {
    for (const [frameId, pose] of Object.entries(item.physicalRest.poses)) {
      const report = validateRestPose(definition, item, { position: pose.positionMm, rotation: pose.rotationMatrix }, frameId);
      assert.equal(report.ok, true, `${definition.id}/${item.id}/${frameId}: ${report.reasons.join("; ")}`);
      assert.ok(report.minimumMarginMm >= 2, `${definition.id}/${item.id}/${frameId}: stable footprint`);
      assert.ok(Math.abs(report.gapMm) <= 0.5, `${definition.id}/${item.id}/${frameId}: nonpenetrating surface contact`);
      assert.ok(tiltDeg(pose.rotationMatrix, item.physicalRest.localUp) <= 2, `${definition.id}/${item.id}/${frameId}: horizontal rest`);
    }
  });
  const generated = JSON.parse(fs.readFileSync(path.join(root, "missions/lab-assistant/v2/generated/scenarios", source.name), "utf8"));
  assert.deepEqual(generated, stripValidationForClient(definition), `${definition.id}: source/generated parity`);
}

const watchDefinition = JSON.parse(fs.readFileSync(path.join(root, "missions/lab-assistant/v2/definitions/openarm/openarm-01-weighing-handoff.json"), "utf8"));
const watch = watchDefinition.objects.find((item) => item.id === "left_watch_glass");
assert.ok(watch);
assert.equal(watch.visual.type, "watch_glass");
assert.equal(watch.visual.variant, "flat");
assert.equal(watch.visual.directHandling, true);
assert.equal(watch.visual.containerFree, true);
const initialPose = watch.physicalRest.poses[watch.initialFrame];

const browserClient = stripValidationForClient(watchDefinition);
const semanticShortcutEngine = await ScenarioV2Engine.create(browserClient, { autoStartPlant: false });
try {
  const before = structuredClone(semanticShortcutEngine.state.objects);
  for (const method of ["skills.transport", "robot.grasp", "robot.release"]) {
    const result = await semanticShortcutEngine.call(method, {});
    assert.equal(result.ok, false, `${method}: semantic shortcut must fail in portable browser clients`);
    assert.equal(result.code, "PHYSICAL_SEND_ACTION_REQUIRED", `${method}: explicit physical-action failure code`);
  }
  assert.deepEqual(semanticShortcutEngine.state.objects, before, "semantic shortcuts must not mutate portable object state");
  assert.equal(semanticShortcutEngine.state.eventLog.length, 0, "semantic shortcuts must not fabricate contact or attachment events");
} finally {
  semanticShortcutEngine.dispose();
}

const withSyntheticSupport = structuredClone(watchDefinition);
withSyntheticSupport.fixtures[0].collisionProxies.push({ id: "invented-registration-pin", type: "box", centerMm: [0, 10, 0], halfExtentsMm: [3, 10, 3], planningRole: "contact_support" });
assert.equal(validatePhysicalRestDefinition(withSyntheticSupport).ok, false, "synthetic registration pins must fail closed");

const xTilt = 12 * Math.PI / 180;
const tilted = { position: [...initialPose.positionMm], rotation: [1, 0, 0, 0, Math.cos(xTilt), -Math.sin(xTilt), 0, Math.sin(xTilt), Math.cos(xTilt)] };
assert.equal(validateRestPose(watchDefinition, watch, tilted, watch.initialFrame).ok, false, "unsupported tilted watch glass must fail");
for (const [label, position] of [
  ["gap", initialPose.positionMm.map((value, axis) => value + (axis === 1 ? 10 : 0))],
  ["penetration", initialPose.positionMm.map((value, axis) => value - (axis === 1 ? 10 : 0))],
  ["unstable footprint", initialPose.positionMm.map((value, axis) => value + (axis === 0 ? 400 : 0))],
]) assert.equal(validateRestPose(watchDefinition, watch, { position, rotation: identity }, watch.initialFrame).ok, false, `${label} must fail`);

const connection = { instanceId: "physical-rest", config: { kind: "bimanual", side: "bimanual", cameras: {} } };
const engine = await ScenarioV2Engine.create(watchDefinition, { autoStartPlant: false });
try {
  assert.equal((await engine.call("compat.connect", connection)).ok, true);
  const closedAtHome = { "left_gripper.pos": 0, "right_gripper.pos": 0 };
  assert.equal((await engine.call("compat.send_action", { instanceId: connection.instanceId, action: closedAtHome, options: {} })).ok, true);
  for (let tick = 0; tick < 60; tick += 1) engine.plant.tick();
  assert.equal(Object.values(engine.state.objects).some((item) => item.attachedTo), false, "closing away from valid contact must not auto-attach");
  engine.reset();
  assert.equal((await engine.call("compat.connect", connection)).ok, true);

  const releaseMotion = [];
  let prior = structuredClone(engine.state.objects);
  for (const step of watchDefinition.portablePython.referenceActions) {
    assert.equal((await engine.call("compat.send_action", { instanceId: connection.instanceId, action: step.action, options: {} })).ok, true, step.label);
    for (let tick = 0; tick < Math.ceil(step.hold_seconds / engine.plant.tickSeconds); tick += 1) {
      engine.plant.tick();
      assert.equal(engine.plant.fault, null, `${step.label}: plant fault`);
      for (const item of Object.values(engine.state.objects)) {
        const before = prior[item.id];
        if (before?.attachedTo && !item.attachedTo) releaseMotion.push(Math.hypot(...item.worldPositionMm.map((value, axis) => value - before.worldPositionMm[axis])));
      }
      prior = structuredClone(engine.state.objects);
    }
  }
  const events = engine.state.eventLog;
  for (const item of watchDefinition.objects) {
    const contactIndex = events.findIndex((event) => event.type === "CONTACT" && event.objectId === item.id);
    const attachIndex = events.findIndex((event) => event.type === "ATTACH_OBJECT" && event.objectId === item.id);
    const placeIndex = events.findIndex((event) => event.type === "PLACE_CONTACT" && event.objectId === item.id);
    const detachIndex = events.findIndex((event) => event.type === "DETACH_OBJECT" && event.objectId === item.id);
    assert.ok(contactIndex >= 0 && contactIndex < attachIndex, `${item.id}: contact must precede closure attachment`);
    assert.ok(
      attachIndex < placeIndex && placeIndex < detachIndex,
      `${item.id}: real placement contact must precede release (attach=${attachIndex}, place=${placeIndex}, detach=${detachIndex})`,
    );
    assert.equal(events[detachIndex].stableRest, true, `${item.id}: release must be a validated stable rest`);
  }
  assert.equal(events.some((event) => ["REST_POSE_REJECTED", "GRASP_REJECTED"].includes(event.type)), false);
  assert.ok(releaseMotion.length >= 2 && releaseMotion.every((distance) => distance < 0.01), `release must preserve the opened-gripper world pose: ${releaseMotion.join(",")}`);
  const finalWatch = engine.state.objects.left_watch_glass;
  assert.equal(finalWatch.currentFrame, "left_handoff");
  assert.ok(tiltDeg(finalWatch.worldRotationMatrix) <= 2, "placed watch glass must finish horizontal on the real worktop");
} finally {
  engine.dispose();
}

console.log("portable physical-rest regression: PASS (30 definitions + generated parity + negative support/rest/attachment/release cases)");
