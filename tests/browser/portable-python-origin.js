import { ScenarioV2Engine } from "../../lab/v2/scenario-engine.js?v=20260823-portable-python-v1";
import { PythonRpcClient } from "../../lab/v2/python-rpc.js?v=20260823-portable-python-v1";
import { compileV2BlocklyProgram } from "../../lab/v2/blockly-api.js?v=20260823-portable-python-v1";

const result = document.querySelector("#result");
const cases = [
  {
    robotId: "so101_follower",
    definition: "../../missions/lab-assistant/v2/generated/scenarios/so101-v2-01-weigh-boat.json",
    profiles: { "transport.json": { port: "SIM" }, "workcell.json": {} },
    source: `
import time
from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
assert __name__ == "__main__", "module name"
assert SO101FollowerConfig(port="SIM").position_p_coefficient == 16, "catalog default P coefficient"
robot = SO101Follower(SO101FollowerConfig(port="SIM", cameras={}))
robot.connect()
try:
    before = robot.get_observation()
    sent = robot.send_action({"shoulder_pan.pos": 12.0})
    assert sent == {"shoulder_pan.pos": 12.0}, "send_action immediate return"
    assert before["shoulder_pan.pos"] != 12.0, "observation must precede target motion"
    start = time.monotonic()
    time.sleep(0.2)
    end = time.monotonic()
    assert end + 1e-9 >= start + 0.2, f"simulation sleep clock: start={start}, end={end}"
    # Both functions read the simulation clock; a 20 ms plant tick may land
    # between the two bridge calls on a busy browser process.
    assert abs(time.perf_counter() - time.monotonic()) <= 0.02, "clock calls must be at most one plant tick apart"
    assert robot.get_observation()["shoulder_pan.pos"] != before["shoulder_pan.pos"], "live observation must advance"
finally:
    robot.disconnect()
print("SO101_OK")`
  },
  {
    robotId: "lekiwi_sim",
    definition: "../../missions/lab-assistant/v2/generated/scenarios/lekiwi-01-beaker-courier.json",
    profiles: { "transport.json": { remote_ip: "127.0.0.1" }, "workcell.json": {} },
    source: `
import time
import numpy as np
from lerobot.robots.lekiwi import LeKiwiClient, LeKiwiClientConfig
robot = LeKiwiClient(LeKiwiClientConfig(remote_ip="127.0.0.1", cameras={}))
robot.connect()
try:
    sent = robot.send_action({"x.vel": 0.1, "theta.vel": 10.0})
    assert sent["action"].dtype == np.float32 and sent["action"].shape == (9,)
    assert list(sent) == ["arm_shoulder_pan.pos", "arm_shoulder_lift.pos", "arm_elbow_flex.pos", "arm_wrist_flex.pos", "arm_wrist_roll.pos", "arm_gripper.pos", "x.vel", "y.vel", "theta.vel", "action"]
    time.sleep(0.6)
    stopped = robot.get_observation()
    assert stopped["x.vel"] == 0 and stopped["theta.vel"] == 0
finally:
    robot.disconnect()
print("LEKIWI_OK")`
  },
  {
    robotId: "openarm_v2_bimanual",
    definition: "../../missions/lab-assistant/v2/generated/scenarios/openarm-01-weighing-handoff.json",
    profiles: { "transport.json": { left_port: "can0", right_port: "can1" }, "workcell.json": {} },
    source: `
import time
import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient
from trajectory_msgs.msg import JointTrajectoryPoint
from control_msgs.action import FollowJointTrajectory
from builtin_interfaces.msg import Duration
from lerobot.robots.openarm_follower import OpenArmFollowerConfigBase
from lerobot.robots.bi_openarm_follower import BiOpenArmFollower, BiOpenArmFollowerConfig
left = OpenArmFollowerConfigBase(port="can0", side="left", cameras={})
right = OpenArmFollowerConfigBase(port="can1", side="right", cameras={})
robot = BiOpenArmFollower(BiOpenArmFollowerConfig(left_arm_config=left, right_arm_config=right, cameras={}))
robot.connect()
try:
    # Use the source-backed first reference pose; an arbitrary joint-1 sweep can
    # honestly contact a configured registration pin in this compact workcell.
    sent = robot.send_action({
        "left_joint_1.pos": 13.878588, "left_joint_2.pos": -28.982068,
        "left_joint_3.pos": -27.837567, "left_joint_4.pos": 100.184156,
        "left_joint_5.pos": 0.0, "left_joint_6.pos": 24.912779,
        "left_joint_7.pos": 0.0, "left_gripper.pos": -65.0,
        "right_joint_1.pos": 25.0, "right_joint_2.pos": 35.0,
        "right_joint_3.pos": 0.0, "right_joint_4.pos": 75.0,
        "right_joint_5.pos": 0.0, "right_joint_6.pos": 5.0,
        "right_joint_7.pos": 0.0, "right_gripper.pos": -65.0,
    })
    assert sent["left_joint_1.pos"] == 13.878588
    time.sleep(0.1)
finally:
    robot.disconnect()
rclpy.init()
node = Node("browser_source_pattern")
client = ActionClient(node, FollowJointTrajectory, "/left_joint_trajectory_controller/follow_joint_trajectory")
goal = FollowJointTrajectory.Goal()
goal.trajectory.joint_names = [f"openarm_left_joint{i}" for i in range(1, 8)]
point = JointTrajectoryPoint(); point.positions = [0.0, -0.2, 0.0, 0.5, 0.0, 0.0, 0.0]; point.time_from_start = Duration(sec=0, nanosec=100000000)
goal.trajectory.points = [point]
future = client.send_goal_async(goal)
rclpy.spin_until_future_complete(node, future)
handle = future.result(); assert handle.accepted
result_future = handle.get_result_async(); rclpy.spin_until_future_complete(node, result_future)
assert result_future.result().result.error_code == 0
node.destroy_node(); rclpy.shutdown()
print("OPENARM_OK")`
  }
];

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

function referenceSource(robotId) {
  const common = `
import json
import time
assert __name__ == "__main__"
with open("transport.json", encoding="utf-8") as stream:
    transport = json.load(stream)
with open("workcell.json", encoding="utf-8") as stream:
    workcell = json.load(stream)`;
  const setup = robotId === "so101_follower" ? `
from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
robot = SO101Follower(SO101FollowerConfig(port=transport["port"], cameras={}))`
    : robotId === "lekiwi_sim" ? `
from lerobot.robots.lekiwi import LeKiwiClient, LeKiwiClientConfig
robot = LeKiwiClient(LeKiwiClientConfig(remote_ip=transport["remote_ip"], cameras={}))`
      : `
from lerobot.robots.openarm_follower import OpenArmFollowerConfigBase
from lerobot.robots.bi_openarm_follower import BiOpenArmFollower, BiOpenArmFollowerConfig
robot = BiOpenArmFollower(BiOpenArmFollowerConfig(
    left_arm_config=OpenArmFollowerConfigBase(port=transport["left_port"], side="left", cameras={}),
    right_arm_config=OpenArmFollowerConfigBase(port=transport["right_port"], side="right", cameras={}),
    cameras={},
))`;
  return `${common}${setup}
robot.connect()
try:
    for step in workcell["reference_actions"]:
        robot.send_action(step["action"])
        time.sleep(step["hold_seconds"])
finally:
    robot.disconnect()
print("REFERENCE_OK")`;
}

function blocklySource(robotId, step) {
  const action = step.action;
  const specs = robotId === "so101_follower" ? [{ type: "portable_so101_action", fields: {
    PAN: action["shoulder_pan.pos"], LIFT: action["shoulder_lift.pos"], ELBOW: action["elbow_flex.pos"], WRIST_FLEX: action["wrist_flex.pos"], WRIST_ROLL: action["wrist_roll.pos"], GRIPPER: action["gripper.pos"], WAIT: 0.1,
  }}] : robotId === "lekiwi_sim" ? [{ type: "portable_lekiwi_action", fields: {
    PAN: action["arm_shoulder_pan.pos"], LIFT: action["arm_shoulder_lift.pos"], ELBOW: action["arm_elbow_flex.pos"], WRIST_FLEX: action["arm_wrist_flex.pos"], WRIST_ROLL: action["arm_wrist_roll.pos"], GRIPPER: action["arm_gripper.pos"], X: action["x.vel"], Y: action["y.vel"], THETA: action["theta.vel"], WAIT: 0.1,
  }}] : ["left", "right"].map((side) => ({ type: "portable_openarm_action", fields: {
    SIDE: side, ...Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`J${index + 1}`, action[`${side}_joint_${index + 1}.pos`]])), GRIPPER: action[`${side}_gripper.pos`], WAIT: side === "right" ? 0.1 : 0,
  }}));
  const blocks = specs.map((spec) => ({ type: spec.type, getFieldValue: (name) => spec.fields[name], getInputTargetBlock: () => null, getNextBlock: () => null }));
  blocks.forEach((block, index) => { block.getNextBlock = () => blocks[index + 1] || null; });
  return compileV2BlocklyProgram({ getTopBlocks: () => [blocks[0]] }, { robotId });
}

async function execute(testCase, definition, source, profiles, timeoutMs) {
  const engine = await ScenarioV2Engine.create(definition, { autoStartPlant: true });
  const client = new PythonRpcClient({
    workerUrl: "../../js/python-worker.js?v=20260823-portable-python-v1",
    timeoutMs,
    apiHandler: async (method, args) => {
      const response = await engine.call(method, args);
      if (!response.ok) {
        const collision = response.state?.plant?.fault?.collision;
        const detail = collision ? ` (${collision.robotProxyId} -> ${collision.obstacleId})` : "";
        throw Object.assign(new Error(`${response.message}${detail}`), { code: response.code });
      }
      return response.publicResult ?? null;
    }
  });
  try {
    const output = await client.run(source, { robotId: testCase.robotId, apiLevel: definition.api.level, timeoutMs, profileFiles: profiles });
    return { robotId: testCase.robotId, stdout: output.stdout.trim(), state: engine.snapshot() };
  } finally {
    client.dispose(); engine.dispose();
  }
}

async function runCase(testCase) {
  const definition = await loadJson(testCase.definition);
  let compatibility;
  try {
    compatibility = await execute(testCase, definition, testCase.source, testCase.profiles, 30000);
  } catch (error) {
    throw new Error(`${testCase.robotId} compatibility execution failed: ${error.message}`, { cause: error });
  }
  let blockly;
  try {
    blockly = await execute(testCase, definition, blocklySource(testCase.robotId, definition.portablePython.referenceActions[0]), testCase.profiles, 30000);
  } catch (error) {
    throw new Error(`${testCase.robotId} Blockly execution failed: ${error.message}`, { cause: error });
  }
  if (!blockly.state.lastAction || Object.keys(blockly.state.lastAction).length === 0) throw new Error(`${testCase.robotId}: browser Blockly source did not reach send_action.`);
  let reference;
  try {
    reference = await execute(testCase, definition, referenceSource(testCase.robotId), {
      ...testCase.profiles,
      "workcell.json": { reference_actions: definition.portablePython.referenceActions },
    }, 120000);
  } catch (error) {
    throw new Error(`${testCase.robotId} reference execution failed: ${error.message}`, { cause: error });
  }
  if (!reference.state.grade.passed) throw new Error(`${testCase.robotId}: browser reference execution did not satisfy authoritative grading (${reference.state.grade.code}).`);
  return { ...compatibility, blocklySendAction: true, referenceStdout: reference.stdout, referenceGrade: reference.state.grade.code };
}

try {
  const outputs = [];
  for (const testCase of cases) outputs.push(await runCase(testCase));
  window.__PORTABLE_PYTHON_RESULT__ = { ok: true, outputs };
  result.textContent = JSON.stringify(window.__PORTABLE_PYTHON_RESULT__, null, 2);
  document.documentElement.dataset.gate = "pass";
} catch (error) {
  window.__PORTABLE_PYTHON_RESULT__ = { ok: false, error: error.message, stack: error.stack };
  result.textContent = JSON.stringify(window.__PORTABLE_PYTHON_RESULT__, null, 2);
  document.documentElement.dataset.gate = "fail";
} finally {
  result.dataset.complete = "true";
}
