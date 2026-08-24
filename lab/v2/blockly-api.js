import { API_LEVELS } from "./api-contract.js";

const BLOCKS = Object.freeze([
  { type: "portable_observation", portable: true, level: "guided", robotIds: ["so101_follower", "lekiwi_sim", "openarm_v2_bimanual"], message0: "read live robot observation", previousStatement: null, nextStatement: null, colour: 120 },
  {
    type: "portable_so101_action", portable: true, level: "guided", robotIds: ["so101_follower"],
    message0: "SO-101 target pan %1 lift %2 elbow %3 wrist flex %4 wrist roll %5 gripper %6 then wait seconds %7",
    args0: [
      { type: "field_number", name: "PAN", value: 0 }, { type: "field_number", name: "LIFT", value: -90 },
      { type: "field_number", name: "ELBOW", value: 85 }, { type: "field_number", name: "WRIST_FLEX", value: 72 },
      { type: "field_number", name: "WRIST_ROLL", value: 0 }, { type: "field_number", name: "GRIPPER", value: 20, min: 0, max: 100 },
      { type: "field_number", name: "WAIT", value: 1, min: 0, max: 30, precision: 0.02 }
    ], previousStatement: null, nextStatement: null, colour: 120
  },
  {
    type: "portable_lekiwi_action", portable: true, level: "guided", robotIds: ["lekiwi_sim"],
    message0: "LeKiwi target arm pan %1 lift %2 elbow %3 wrist flex %4 roll %5 gripper %6 base x m/s %7 y m/s %8 yaw deg/s %9 then wait seconds %10",
    args0: ["PAN", "LIFT", "ELBOW", "WRIST_FLEX", "WRIST_ROLL", "GRIPPER", "X", "Y", "THETA", "WAIT"].map((name, index) => ({ type: "field_number", name, value: index === 5 ? 20 : index === 9 ? 1 : 0, precision: index >= 6 && index <= 8 ? 0.01 : 0.1 })),
    previousStatement: null, nextStatement: null, colour: 120
  },
  {
    type: "portable_openarm_action", portable: true, level: "guided", robotIds: ["openarm_v2_bimanual"],
    message0: "OpenArm %1 target J1 %2 J2 %3 J3 %4 J4 %5 J5 %6 J6 %7 J7 %8 gripper %9 then wait seconds %10",
    args0: [{ type: "field_dropdown", name: "SIDE", options: [["left", "left"], ["right", "right"]] }, ...["J1", "J2", "J3", "J4", "J5", "J6", "J7", "GRIPPER", "WAIT"].map((name, index) => ({ type: "field_number", name, value: index === 3 ? 30 : index === 7 ? -20 : index === 8 ? 1 : 0, precision: 0.1 }))],
    previousStatement: null, nextStatement: null, colour: 120
  },
  { type: "v2_observe", level: "guided", message0: "observe lab state", previousStatement: null, nextStatement: null, colour: 165 },
  { type: "v2_so101_command_model", level: "guided", robotIds: ["so101_follower"], message0: "inspect SO-101 joint command model", previousStatement: null, nextStatement: null, colour: 120 },
  { type: "v2_so101_observation", level: "guided", robotIds: ["so101_follower"], message0: "read SO-101 position observation", previousStatement: null, nextStatement: null, colour: 120 },
  {
    type: "v2_so101_send_action",
    level: "guided",
    robotIds: ["so101_follower"],
    message0: "SO-101 send joint target pan %1 lift %2 elbow %3 wrist flex %4 wrist roll %5 gripper 0..100 %6 visual duration ms %7",
    args0: [
      { type: "field_number", name: "PAN", value: 0, min: -110, max: 110, precision: 0.1 },
      { type: "field_number", name: "LIFT", value: -90, min: -100, max: 100, precision: 0.1 },
      { type: "field_number", name: "ELBOW", value: 85, min: -96.83, max: 96.83, precision: 0.1 },
      { type: "field_number", name: "WRIST_FLEX", value: 72, min: -95, max: 95, precision: 0.1 },
      { type: "field_number", name: "WRIST_ROLL", value: 88, min: -157.21, max: 162.79, precision: 0.1 },
      { type: "field_number", name: "GRIPPER", value: 20, min: 0, max: 100, precision: 0.1 },
      { type: "field_number", name: "DURATION", value: 480, min: 0, max: 5000, precision: 10 }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 120
  },
  { type: "v2_transport", level: "guided", message0: "transport object %1 approach %2 contact %3 lift %4 destination %5 place contact %6 retreat %7 effector %8", args0: ["OBJECT", "APPROACH", "CONTACT", "LIFT", "DESTINATION", "PLACE", "RETREAT", "EFFECTOR"].map((name) => ({ type: "field_input", name, text: ["PLACE", "EFFECTOR"].includes(name) ? "" : name.toLowerCase() })), previousStatement: null, nextStatement: null, colour: 165 },
  { type: "v2_fixture_operation", level: "guided", message0: "operate process %1 with object %2 at fixture %3", args0: [{ type: "field_input", name: "PROCESS", text: "process_id" }, { type: "field_input", name: "OBJECT", text: "object_id" }, { type: "field_input", name: "FIXTURE", text: "fixture_id" }], previousStatement: null, nextStatement: null, colour: 165 },
  { type: "v2_record_evidence", level: "guided", message0: "record evidence %1 value %2", args0: [{ type: "field_input", name: "REQUIREMENT", text: "evidence_id" }, { type: "field_input", name: "VALUE", text: "visible observation" }], previousStatement: null, nextStatement: null, colour: 165 },
  { type: "v2_plan_frame", level: "builder", message0: "plan to frame %1 seed %2", args0: [{ type: "field_input", name: "FRAME", text: "frame_id" }, { type: "field_number", name: "SEED", value: 17, min: 0, precision: 1 }], previousStatement: null, nextStatement: null, colour: 210 },
  { type: "v2_execute_last_plan", level: "builder", message0: "execute last plan", previousStatement: null, nextStatement: null, colour: 210 },
  { type: "v2_replan_frame", level: "builder", message0: "replan to frame %1 alternate seed %2", args0: [{ type: "field_input", name: "FRAME", text: "frame_id" }, { type: "field_number", name: "SEED", value: 101, min: 0, precision: 1 }], previousStatement: null, nextStatement: null, colour: 210 },
  { type: "v2_navigate", level: "builder", message0: "navigate to named frame %1", args0: [{ type: "field_input", name: "FRAME", text: "dock_frame" }], previousStatement: null, nextStatement: null, colour: 210 },
  { type: "v2_repeat", level: "challenge", message0: "repeat %1 times", args0: [{ type: "field_number", name: "COUNT", value: 2, min: 0, max: 20, precision: 1 }], message1: "do %1", args1: [{ type: "input_statement", name: "DO" }], previousStatement: null, nextStatement: null, colour: 285 },
  { type: "v2_if_object_at", level: "challenge", message0: "if object %1 is at frame %2", args0: [{ type: "field_input", name: "OBJECT", text: "object_id" }, { type: "field_input", name: "FRAME", text: "frame_id" }], message1: "do %1", args1: [{ type: "input_statement", name: "DO" }], previousStatement: null, nextStatement: null, colour: 285 },
  { type: "v2_solve_ik", level: "challenge", message0: "solve IK for frame %1 seed %2", args0: [{ type: "field_input", name: "FRAME", text: "frame_id" }, { type: "field_number", name: "SEED", value: 73, min: 0, precision: 1 }], previousStatement: null, nextStatement: null, colour: 285 }
]);

function available(level, robotId = "") {
  return BLOCKS.filter((block) => (
    API_LEVELS[level] >= API_LEVELS[block.level]
    && (!robotId || !block.robotIds?.length || block.robotIds.includes(robotId))
    && (!(["so101_follower", "lekiwi_sim", "openarm_v2_bimanual"].includes(robotId)) || block.portable === true || block.type === "v2_repeat")
  ));
}

export function registerV2Blocks(Blockly) {
  available("challenge").forEach((definition) => {
    if (!Blockly.Blocks[definition.type]) Blockly.Blocks[definition.type] = { init() { this.jsonInit(definition); } };
  });
}

export function createV2Toolbox(level = "guided", robotId = "") {
  const categories = [
    { id: "guided", name: "Guided skills", colour: "#197d74" },
    { id: "builder", name: "Builder planning", colour: "#356d9a" },
    { id: "challenge", name: "Challenge control", colour: "#76529a" }
  ];
  return {
    kind: "categoryToolbox",
    contents: categories.flatMap((category) => {
      const contents = available(level, robotId).filter((block) => block.level === category.id).map((block) => ({ kind: "block", type: block.type }));
      return contents.length ? [{ kind: "category", name: category.name, colour: category.colour, contents }] : [];
    })
  };
}

function quote(value) { return JSON.stringify(String(value || "")); }

function blockLine(block, indent, context) {
  const pad = "    ".repeat(indent);
  const field = (name) => block.getFieldValue(name);
  if (block.type === "portable_observation") return [`${pad}observation = robot.get_observation()`, `${pad}print(observation)`];
  if (block.type === "portable_so101_action") {
    const action = [["shoulder_pan.pos", "PAN"], ["shoulder_lift.pos", "LIFT"], ["elbow_flex.pos", "ELBOW"], ["wrist_flex.pos", "WRIST_FLEX"], ["wrist_roll.pos", "WRIST_ROLL"], ["gripper.pos", "GRIPPER"]].map(([key, name]) => `${quote(key)}: ${Number(field(name))}`).join(", ");
    return [`${pad}robot.send_action({${action}})`, `${pad}time.sleep(${Math.max(0, Number(field("WAIT")) || 0)})`];
  }
  if (block.type === "portable_lekiwi_action") {
    const fields = [["arm_shoulder_pan.pos", "PAN"], ["arm_shoulder_lift.pos", "LIFT"], ["arm_elbow_flex.pos", "ELBOW"], ["arm_wrist_flex.pos", "WRIST_FLEX"], ["arm_wrist_roll.pos", "WRIST_ROLL"], ["arm_gripper.pos", "GRIPPER"], ["x.vel", "X"], ["y.vel", "Y"], ["theta.vel", "THETA"]];
    const action = fields.map(([key, name]) => `${quote(key)}: ${Number(field(name))}`).join(", ");
    return [`${pad}robot.send_action({${action}})`, `${pad}time.sleep(${Math.max(0, Number(field("WAIT")) || 0)})`];
  }
  if (block.type === "portable_openarm_action") {
    const side = field("SIDE") === "right" ? "right" : "left";
    const action = [...Array.from({ length: 7 }, (_, index) => [`${side}_joint_${index + 1}.pos`, `J${index + 1}`]), [`${side}_gripper.pos`, "GRIPPER"]].map(([key, name]) => `${quote(key)}: ${Number(field(name))}`).join(", ");
    return [`${pad}robot.send_action({${action}})`, `${pad}time.sleep(${Math.max(0, Number(field("WAIT")) || 0)})`];
  }
  if (block.type === "v2_observe") return [`${pad}observation = await lab.observe()`];
  if (block.type === "v2_so101_command_model") return [`${pad}command_model = await robot.command_model()`];
  if (block.type === "v2_so101_observation") return [`${pad}position_observation = await robot.get_observation()`];
  if (block.type === "v2_so101_send_action") {
    const action = [
      ["shoulder_pan.pos", "PAN"],
      ["shoulder_lift.pos", "LIFT"],
      ["elbow_flex.pos", "ELBOW"],
      ["wrist_flex.pos", "WRIST_FLEX"],
      ["wrist_roll.pos", "WRIST_ROLL"],
      ["gripper.pos", "GRIPPER"]
    ].map(([key, name]) => `${quote(key)}: ${Number(field(name))}`).join(", ");
    return [`${pad}await robot.send_action({${action}}, duration_ms=${Number(field("DURATION")) || 0})  # visual interpolation is simulation-only`];
  }
  if (block.type === "v2_transport") {
    const optional = [];
    const place = String(field("PLACE") || "").trim();
    const effector = String(field("EFFECTOR") || "").trim();
    if (place) optional.push(`place_frame=${quote(place)}`);
    if (effector && effector !== "default") optional.push(`effector=${quote(effector)}`);
    return [`${pad}await robot.transport(${quote(field("OBJECT"))}, approach_frame=${quote(field("APPROACH"))}, contact_frame=${quote(field("CONTACT"))}, lift_frame=${quote(field("LIFT"))}, destination_frame=${quote(field("DESTINATION"))}, retreat_frame=${quote(field("RETREAT"))}${optional.length ? `, ${optional.join(", ")}` : ""})`];
  }
  if (block.type === "v2_fixture_operation") return [`${pad}await lab.fixture_operation(${quote(field("PROCESS"))}, object_id=${quote(field("OBJECT"))}, fixture_id=${quote(field("FIXTURE"))})`];
  if (block.type === "v2_record_evidence") return [`${pad}await lab.record_evidence(${quote(field("REQUIREMENT"))}, ${quote(field("VALUE"))})`];
  if (block.type === "v2_plan_frame") return [`${pad}${context.planVariable} = await robot.plan_to_frame(${quote(field("FRAME"))}, seed=${Number(field("SEED")) || 0})`];
  if (block.type === "v2_execute_last_plan") return [`${pad}await robot.execute(${context.planVariable}["planId"])`];
  if (block.type === "v2_replan_frame") return [`${pad}${context.planVariable} = await robot.replan(${quote(field("FRAME"))}, seed=${Number(field("SEED")) || 0})`];
  if (block.type === "v2_navigate") return [`${pad}await robot.navigate(${quote(field("FRAME"))})`];
  if (block.type === "v2_solve_ik") return [`${pad}ik_result = await robot.solve_ik(frame_id=${quote(field("FRAME"))}, seed=${Number(field("SEED")) || 0})`];
  if (block.type === "v2_repeat") {
    const body = compileChain(block.getInputTargetBlock("DO"), indent + 1, context);
    return [`${pad}for _index in range(${Math.max(0, Number(field("COUNT")) || 0)}):`, ...(body.length ? body : [`${pad}    pass`])];
  }
  if (block.type === "v2_if_object_at") {
    const variable = `_observation_${context.branchCounter++}`;
    const body = compileChain(block.getInputTargetBlock("DO"), indent + 1, context);
    return [
      `${pad}${variable} = await lab.observe()`,
      `${pad}if ${variable}["observation"]["objects"].get(${quote(field("OBJECT"))}, {}).get("currentFrame") == ${quote(field("FRAME"))}:`,
      ...(body.length ? body : [`${pad}    pass`])
    ];
  }
  throw new Error(`Unsupported ScenarioV2 Blockly block: ${block.type}.`);
}

function compileChain(first, indent, context) {
  const lines = [];
  let block = first;
  while (block) {
    lines.push(...blockLine(block, indent, context));
    block = block.getNextBlock();
  }
  return lines;
}

function portableWrapper(robotId, body) {
  const indented = body.map((line) => `    ${line}`);
  if (robotId === "so101_follower") return [
    "import json", "import time", "from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig", "",
    "with open(\"transport.json\", encoding=\"utf-8\") as stream:", "    transport = json.load(stream)",
    "robot = SO101Follower(SO101FollowerConfig(port=transport[\"port\"], cameras={}))", "robot.connect()", "try:", ...indented, "finally:", "    robot.disconnect()"
  ];
  if (robotId === "lekiwi_sim") return [
    "import json", "import time", "from lerobot.robots.lekiwi import LeKiwiClient, LeKiwiClientConfig", "",
    "with open(\"transport.json\", encoding=\"utf-8\") as stream:", "    transport = json.load(stream)",
    "robot = LeKiwiClient(LeKiwiClientConfig(remote_ip=transport[\"remote_ip\"], cameras={}))", "robot.connect()", "try:", ...indented, "finally:", "    robot.disconnect()"
  ];
  return [
    "import json", "import time", "from lerobot.robots.openarm_follower import OpenArmFollowerConfigBase", "from lerobot.robots.bi_openarm_follower import BiOpenArmFollower, BiOpenArmFollowerConfig", "",
    "with open(\"transport.json\", encoding=\"utf-8\") as stream:", "    transport = json.load(stream)",
    "config = BiOpenArmFollowerConfig(left_arm_config=OpenArmFollowerConfigBase(port=transport[\"left_port\"], side=\"left\", cameras={}), right_arm_config=OpenArmFollowerConfigBase(port=transport[\"right_port\"], side=\"right\", cameras={}), cameras={})",
    "robot = BiOpenArmFollower(config)", "robot.connect()", "try:", ...indented, "finally:", "    robot.disconnect()"
  ];
}

export function compileV2BlocklyProgram(workspace, options = {}) {
  const top = workspace.getTopBlocks(true);
  if (!top.length) throw new Error("Add at least one ScenarioV2 block before running.");
  const context = { planVariable: "last_plan", branchCounter: 1 };
  const portable = ["so101_follower", "lekiwi_sim", "openarm_v2_bimanual"].includes(options.robotId);
  const body = top.flatMap((block) => compileChain(block, portable ? 0 : 1, context));
  if (portable) return portableWrapper(options.robotId, body).join("\n");
  return ["async def main(robot, lab):", ...body].join("\n");
}

export const V2_BLOCK_DEFINITIONS = BLOCKS;
