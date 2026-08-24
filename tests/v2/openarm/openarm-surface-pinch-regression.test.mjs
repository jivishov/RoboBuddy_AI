import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioV2Engine } from "../../../lab/v2/scenario-engine.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const definition = JSON.parse(fs.readFileSync(
  path.join(root, "missions/lab-assistant/v2/generated/scenarios/openarm-02-glassware-handoff.json"),
  "utf8",
));
const engine = await ScenarioV2Engine.create(definition, { autoStartPlant: false });
const instanceId = "openarm-surface-pinch-regression";
const attachedBySide = new Map();
const releasedBySide = new Map();
let maximumDensePenetrationMm = 0;
let rightFullyClosedCommandObserved = false;

try {
  assert.equal((await engine.call("compat.connect", {
    instanceId,
    config: { kind: "bimanual", side: "bimanual", cameras: {} },
  })).ok, true);

  for (const step of definition.portablePython.referenceActions) {
    const sent = await engine.call("compat.send_action", { instanceId, action: step.action, options: {} });
    assert.equal(sent.ok, true, `${step.label}: ${sent.code} ${sent.message}`);
    for (let tick = 0; tick < Math.ceil(Number(step.hold_seconds) / engine.plant.tickSeconds); tick += 1) {
      engine.plant.tick();
      assert.equal(engine.plant.fault, null, `${step.label}: ${engine.plant.fault?.message || "plant fault"}`);
      for (const object of Object.values(engine.state.objects)) {
        if (!object.attachedTo) continue;
        const side = object.attachedTo;
        const constraint = object.graspConstraint;
        assert.equal(constraint?.schema, "robobuddy.surface-pinch.v1", `${side} must carry through a captured physical surface pinch`);
        assert.equal(constraint.gripperJointId, `${side}_gripper`);
        assert.equal(constraint.closeDirection, -1);
        const report = engine.plant.objectFingerContactReport(object, side, engine.state.jointState, engine.state.rootPose);
        maximumDensePenetrationMm = Math.max(maximumDensePenetrationMm, report.maxPenetrationMmObserved);
        assert.ok(
          report.maxPenetrationMmObserved <= constraint.maxPenetrationMm + 1e-6,
          `${side}/${object.id}: dense official finger mesh penetrated ${report.maxPenetrationMmObserved} mm`,
        );
        assert.ok(
          Number(engine.state.jointState[constraint.gripperJointId]) >= Number(constraint.gripperValue) - 1e-6,
          `${side}/${object.id}: gripper closed beyond the captured apparatus surface`,
        );
        attachedBySide.set(side, constraint);
        if (side === "right" && Number(engine.plant.commandedJointState.right_gripper) === 0) {
          rightFullyClosedCommandObserved = true;
          assert.ok(Number(engine.state.jointState.right_gripper) > 8, "right bottle must stop on its surface before the legacy <=8 deg closed threshold");
        }
      }
    }
  }

  const events = engine.state.eventLog;
  for (const event of events.filter((item) => item.type === "ATTACH_OBJECT")) {
    assert.equal(event.physicalPinch, true, `${event.objectId}: attachment must be authorized by physical pinch contact`);
    assert.equal(event.graspConstraint?.schema, "robobuddy.surface-pinch.v1");
    assert.equal(event.contactBodies.length, 2, `${event.objectId}: both opposing fingers must contact before attachment`);
    const contact = events.find((item) => item.type === "CONTACT"
      && item.objectId === event.objectId
      && item.effector === event.effector
      && item.clockSeconds <= event.clockSeconds);
    assert.ok(contact, `${event.objectId}: live finger contact must precede attachment`);
  }
  for (const event of events.filter((item) => item.type === "DETACH_OBJECT")) releasedBySide.set(event.effector, event);

  assert.deepEqual([...attachedBySide.keys()].sort(), ["left", "right"], "both OpenArm grippers must independently complete a constrained grasp");
  assert.deepEqual([...releasedBySide.keys()].sort(), ["left", "right"], "both OpenArm grippers must independently open and release");
  assert.equal(rightFullyClosedCommandObserved, true, "test must exercise a full-close official command against the bottle");
  assert.equal(engine.snapshot().grade.passed, true, "surface-bounded task-2 replay must still complete the authoritative task");
} finally {
  engine.dispose();
}

console.log(`OpenArm dense surface-pinch regression: PASS (max finger penetration ${maximumDensePenetrationMm.toFixed(6)} mm)`);
