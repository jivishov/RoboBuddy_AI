import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ScenarioV2Engine } from "../../lab/v2/scenario-engine.js";
import { compileV2BlocklyProgram } from "../../lab/v2/blockly-api.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const folders = ["so101", "lekiwi", "openarm"];
const files = folders.flatMap((folder) => fs.readdirSync(path.join(root, "missions/lab-assistant/v2/definitions", folder))
  .filter((name) => name.endsWith(".json"))
  .map((name) => path.join(root, "missions/lab-assistant/v2/definitions", folder, name)));

function connection(robotId) {
  if (robotId === "so101_follower") return { instanceId: "reference", config: { kind: "so101", port: "SIM", cameras: {} } };
  if (robotId === "lekiwi_sim") return { instanceId: "reference", config: { kind: "lekiwi", remote_ip: "127.0.0.1", cameras: {} } };
  return { instanceId: "reference", config: { kind: "bimanual", side: "bimanual", cameras: {} } };
}

function blockSpec(robotId, step) {
  const action = step.action;
  if (robotId === "so101_follower") return [{ type: "portable_so101_action", fields: {
    PAN: action["shoulder_pan.pos"], LIFT: action["shoulder_lift.pos"], ELBOW: action["elbow_flex.pos"],
    WRIST_FLEX: action["wrist_flex.pos"], WRIST_ROLL: action["wrist_roll.pos"], GRIPPER: action["gripper.pos"], WAIT: step.hold_seconds,
  }}];
  if (robotId === "lekiwi_sim") return [{ type: "portable_lekiwi_action", fields: {
    PAN: action["arm_shoulder_pan.pos"], LIFT: action["arm_shoulder_lift.pos"], ELBOW: action["arm_elbow_flex.pos"],
    WRIST_FLEX: action["arm_wrist_flex.pos"], WRIST_ROLL: action["arm_wrist_roll.pos"], GRIPPER: action["arm_gripper.pos"],
    X: action["x.vel"], Y: action["y.vel"], THETA: action["theta.vel"], WAIT: step.hold_seconds,
  }}];
  return ["left", "right"].map((side) => ({ type: "portable_openarm_action", fields: {
    SIDE: side,
    ...Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`J${index + 1}`, action[`${side}_joint_${index + 1}.pos`]])),
    GRIPPER: action[`${side}_gripper.pos`], WAIT: side === "right" ? step.hold_seconds : 0,
  }}));
}

function mockBlocklyWorkspace(robotId, actions) {
  const specs = actions.flatMap((step) => blockSpec(robotId, step));
  const blocks = specs.map((spec) => ({
    type: spec.type,
    getFieldValue(name) { return spec.fields[name]; },
    getInputTargetBlock() { return null; },
    getNextBlock() { return null; },
  }));
  blocks.forEach((block, index) => { block.getNextBlock = () => blocks[index + 1] || null; });
  return { getTopBlocks() { return blocks.length ? [blocks[0]] : []; } };
}

async function executeBlocklyRoundTrip(definition) {
  const engine = await ScenarioV2Engine.create(definition, { autoStartPlant: false });
  try {
    assert.equal((await engine.call("compat.connect", connection(definition.robotId))).ok, true);
    for (const step of definition.portablePython.referenceActions) {
      for (const spec of blockSpec(definition.robotId, step)) {
        const fields = spec.fields;
        let action;
        if (definition.robotId === "so101_follower") action = {
          "shoulder_pan.pos": fields.PAN, "shoulder_lift.pos": fields.LIFT, "elbow_flex.pos": fields.ELBOW,
          "wrist_flex.pos": fields.WRIST_FLEX, "wrist_roll.pos": fields.WRIST_ROLL, "gripper.pos": fields.GRIPPER,
        };
        else if (definition.robotId === "lekiwi_sim") action = {
          "arm_shoulder_pan.pos": fields.PAN, "arm_shoulder_lift.pos": fields.LIFT, "arm_elbow_flex.pos": fields.ELBOW,
          "arm_wrist_flex.pos": fields.WRIST_FLEX, "arm_wrist_roll.pos": fields.WRIST_ROLL, "arm_gripper.pos": fields.GRIPPER,
          "x.vel": fields.X, "y.vel": fields.Y, "theta.vel": fields.THETA,
        };
        else {
          const side = fields.SIDE;
          action = Object.fromEntries([
            ...Array.from({ length: 7 }, (_, index) => [`${side}_joint_${index + 1}.pos`, fields[`J${index + 1}`]]),
            [`${side}_gripper.pos`, fields.GRIPPER],
          ]);
        }
        const sent = await engine.call("compat.send_action", { instanceId: "reference", action, options: {} });
        assert.equal(sent.ok, true, `${definition.id}/${step.label}: Blockly action failed`);
        const ticks = Math.ceil(Number(fields.WAIT) / engine.plant.tickSeconds);
        for (let index = 0; index < ticks; index += 1) engine.plant.tick();
        assert.equal(engine.plant.fault, null, `${definition.id}/${step.label}: Blockly plant fault`);
      }
    }
    await engine.call("compat.disconnect", { instanceId: "reference" });
    assert.equal(engine.snapshot().grade.passed, true, `${definition.id}: Blockly-generated reference did not satisfy hidden authoritative grading`);
  } finally { engine.dispose(); }
}

const outcomes = [];
for (const file of files) {
  const definition = JSON.parse(fs.readFileSync(file, "utf8"));
  const engine = await ScenarioV2Engine.create(definition, { autoStartPlant: false });
  try {
    const connected = await engine.call("compat.connect", connection(definition.robotId));
    assert.equal(connected.ok, true, `${definition.id}: connect`);
    for (const step of definition.portablePython.referenceActions) {
      const sent = await engine.call("compat.send_action", { instanceId: "reference", action: step.action, options: {} });
      assert.equal(sent.ok, true, `${definition.id}/${step.label}: ${sent.code} ${sent.message}`);
      const ticks = Math.ceil(Number(step.hold_seconds) / engine.plant.tickSeconds);
      for (let index = 0; index < ticks; index += 1) engine.plant.tick();
      assert.equal(engine.plant.fault, null, `${definition.id}/${step.label}: ${engine.plant.fault?.message || "plant fault"}`);
    }
    await engine.call("compat.disconnect", { instanceId: "reference" });
    const snapshot = engine.snapshot();
    assert.equal(snapshot.grade.passed, true, `${definition.id}: ${snapshot.grade.code}; missing=${snapshot.grade.goals.filter((goal) => !goal.passed).map((goal) => goal.id).join(",")}; prohibited=${snapshot.grade.prohibited.filter((item) => item.triggered).map((item) => item.id).join(",")}; causal=${snapshot.grade.causal.map((item) => item.code).join(",")}`);
    outcomes.push({ id: definition.id, actions: definition.portablePython.referenceActions.length });

    const blocklySource = compileV2BlocklyProgram(mockBlocklyWorkspace(definition.robotId, definition.portablePython.referenceActions), { robotId: definition.robotId });
    assert.match(blocklySource, /robot\.connect\(\)/);
    assert.match(blocklySource, /finally:\n    robot\.disconnect\(\)$/);
    assert.doesNotMatch(blocklySource, /async\s+def|await\s+|robot\.transport|fixture_operation|record_evidence/);
    const expectedSendCount = definition.portablePython.referenceActions.length * (definition.robotId === "openarm_v2_bimanual" ? 2 : 1);
    assert.equal((blocklySource.match(/robot\.send_action\(/g) || []).length, expectedSendCount, `${definition.id}: Blockly source action count`);
    await executeBlocklyRoundTrip(definition);

    const negativeEngine = await ScenarioV2Engine.create(definition, { autoStartPlant: false });
    try {
      const cameraRejection = await negativeEngine.call("compat.connect", { ...connection(definition.robotId), instanceId: "camera-negative", config: { ...connection(definition.robotId).config, cameras: { front: {} } } });
      assert.equal(cameraRejection.ok, false, `${definition.id}: nonempty cameras must fail`);
      assert.equal(cameraRejection.code, "CAMERAS_UNSUPPORTED", `${definition.id}: camera guidance code`);
    } finally { negativeEngine.dispose(); }
  } finally { engine.dispose(); }
}

assert.equal(outcomes.length, 30);
console.log(`portable scenario references: PASS (${outcomes.length}/30 hand-code and Blockly-generated task runs plus camera-negative cases)`);
console.log(outcomes.map((item) => `${item.id}:${item.actions}`).join(" "));
