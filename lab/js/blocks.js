const BLOCK_DEFINITIONS = [
  { type: "lab_home", message0: "robot home", args0: [] },
  { type: "lab_stop", message0: "simulation stop", args0: [] },
  { type: "lab_wait", message0: "wait %1 seconds", args0: [{ type: "field_number", name: "SECONDS", value: 1, min: 0, max: 30, precision: 0.1 }] },
  { type: "lab_move_to_pose", message0: "move to task pose %1 in %2 s", args0: [{ type: "field_input", name: "POSE", text: "supply_zone" }, { type: "field_number", name: "SECONDS", value: 1.2, min: 0.2, max: 10, precision: 0.1 }] },
  { type: "lab_move_joint", message0: "move joint %1 to %2 speed %3", args0: [{ type: "field_input", name: "JOINT", text: "base" }, { type: "field_number", name: "VALUE", value: 90, precision: 0.1 }, { type: "field_number", name: "SPEED", value: 45, min: 1, max: 100 }] },
  { type: "lab_move_joints", message0: "move joint pose JSON %1 speed %2", args0: [{ type: "field_input", name: "JOINTS", text: "{}" }, { type: "field_number", name: "SPEED", value: 45, min: 1, max: 100 }] },
  { type: "lab_gripper", message0: "set %1 gripper %2", args0: [{ type: "field_input", name: "EFFECTOR", text: "default" }, { type: "field_dropdown", name: "VALUE", options: [["open", "open"], ["close", "close"]] }] },
  { type: "lab_grasp", message0: "grasp %1 with %2", args0: [{ type: "field_input", name: "OBJECT", text: "watch_glass" }, { type: "field_input", name: "EFFECTOR", text: "default" }] },
  { type: "lab_place", message0: "place %1 at %2 with %3", args0: [{ type: "field_input", name: "OBJECT", text: "watch_glass" }, { type: "field_input", name: "ZONE", text: "balance_zone" }, { type: "field_input", name: "EFFECTOR", text: "default" }] },
  { type: "lab_insert", message0: "insert %1 into %2 with %3", args0: [{ type: "field_input", name: "OBJECT", text: "sample_cuvette" }, { type: "field_input", name: "TARGET", text: "spectrophotometer" }, { type: "field_input", name: "EFFECTOR", text: "default" }] },
  { type: "lab_pour", message0: "transfer %1 into %2 with %3", args0: [{ type: "field_input", name: "OBJECT", text: "source_beaker" }, { type: "field_input", name: "TARGET", text: "receiving_beaker" }, { type: "field_input", name: "EFFECTOR", text: "default" }] },
  { type: "lab_operate", message0: "operate %1 mode %2 value %3 with %4", args0: [{ type: "field_input", name: "CONTROL", text: "cooling_rack" }, { type: "field_input", name: "MODE", text: "cool" }, { type: "field_input", name: "VALUE", text: "" }, { type: "field_input", name: "EFFECTOR", text: "default" }] },
  { type: "lab_read", message0: "read instrument %1", args0: [{ type: "field_input", name: "INSTRUMENT", text: "balance" }] },
  { type: "lab_record", message0: "record %1 value %2", args0: [{ type: "field_input", name: "FIELD", text: "observation" }, { type: "field_input", name: "VALUE", text: "" }] },
  { type: "lab_drive", message0: "drive vx %1 vy %2 omega %3 for %4 s", args0: [{ type: "field_number", name: "VX", value: 0.22, precision: 0.01 }, { type: "field_number", name: "VY", value: 0, precision: 0.01 }, { type: "field_number", name: "OMEGA", value: 0, precision: 1 }, { type: "field_number", name: "SECONDS", value: 1.4, min: 0.1, max: 30, precision: 0.1 }] },
  { type: "lab_walk", message0: "walk %1 steps %2 length %3 m speed %4", args0: [{ type: "field_dropdown", name: "DIRECTION", options: [["forward", "forward"], ["backward", "backward"]] }, { type: "field_number", name: "STEPS", value: 2, min: 1, max: 20, precision: 1 }, { type: "field_number", name: "LENGTH", value: 0.08, min: 0.02, max: 0.12, precision: 0.01 }, { type: "field_number", name: "SPEED", value: 45, min: 1, max: 100 }] },
  { type: "lab_turn", message0: "turn %1 degrees in %2 s", args0: [{ type: "field_number", name: "ANGLE", value: 30, min: -180, max: 180 }, { type: "field_number", name: "SECONDS", value: 1.5, min: 0.2, max: 10, precision: 0.1 }] },
  { type: "lab_posture", message0: "set posture %1 in %2 s", args0: [{ type: "field_input", name: "POSTURE", text: "work_reach" }, { type: "field_number", name: "SECONDS", value: 0.8, min: 0.2, max: 10, precision: 0.1 }] },
  { type: "lab_pick", message0: "pick nearest secured carrier with %1", args0: [{ type: "field_input", name: "HAND", text: "right_hand" }] },
  { type: "lab_release", message0: "release secured carrier with %1", args0: [{ type: "field_input", name: "HAND", text: "right_hand" }] }
];

function enrich(definition) {
  return { ...definition, previousStatement: null, nextStatement: null, colour: definition.type === "lab_stop" ? "#a33f45" : definition.type.startsWith("lab_move") || ["lab_drive", "lab_walk", "lab_turn", "lab_posture", "lab_home", "lab_wait"].includes(definition.type) ? "#4d6f82" : "#197d74", tooltip: "Simulation-only RoboBuddy lab command", helpUrl: "" };
}

export function registerLabBlocks(Blockly) {
  if (!Blockly || Blockly.Blocks.lab_home) return;
  Blockly.defineBlocksWithJsonArray(BLOCK_DEFINITIONS.map(enrich));
}

export function createLabToolbox(definition) {
  const taskBlocks = ["lab_move_to_pose", "lab_grasp", "lab_place", "lab_insert", "lab_pour", "lab_operate", "lab_read", "lab_record"];
  const motionBlocks = ["lab_home", "lab_wait", "lab_move_joint", "lab_move_joints"];
  if (definition.robotId !== "unitree_g1_29dof") motionBlocks.push("lab_gripper");
  if (definition.robotId === "lekiwi_sim") motionBlocks.push("lab_drive");
  if (definition.robotId === "unitree_g1_29dof") motionBlocks.push("lab_walk", "lab_turn", "lab_posture", "lab_pick", "lab_release");
  return {
    kind: "categoryToolbox",
    contents: [
      { kind: "category", name: "Lab actions", colour: "#197d74", contents: taskBlocks.map((type) => ({ kind: "block", type })) },
      { kind: "category", name: "Robot motion", colour: "#4d6f82", contents: motionBlocks.map((type) => ({ kind: "block", type })) },
      { kind: "category", name: "Safety", colour: "#a33f45", contents: [{ kind: "block", type: "lab_stop" }] }
    ]
  };
}

function clean(value) {
  return String(value || "").trim();
}

function number(block, field) {
  return Number(block.getFieldValue(field));
}

function commandFromBlock(block) {
  const field = (name) => clean(block.getFieldValue(name));
  switch (block.type) {
    case "lab_home": return { type: "home" };
    case "lab_stop": return { type: "stop" };
    case "lab_wait": return { type: "wait", seconds: number(block, "SECONDS") };
    case "lab_move_to_pose": return { type: "move_to_pose", poseId: field("POSE"), seconds: number(block, "SECONDS") };
    case "lab_move_joint": return { type: "move_joint", joint: field("JOINT"), value: number(block, "VALUE"), speed: number(block, "SPEED") };
    case "lab_move_joints": return { type: "move_joints", joints: JSON.parse(field("JOINTS") || "{}"), speed: number(block, "SPEED") };
    case "lab_gripper": return { type: "set_gripper", effector: field("EFFECTOR"), value: field("VALUE") };
    case "lab_grasp": return compact({ type: "grasp", objectId: field("OBJECT"), effector: field("EFFECTOR") });
    case "lab_place": return compact({ type: "place", objectId: field("OBJECT"), zoneId: field("ZONE"), effector: field("EFFECTOR") });
    case "lab_insert": return compact({ type: "insert_into", objectId: field("OBJECT"), targetId: field("TARGET"), effector: field("EFFECTOR") });
    case "lab_pour": return compact({ type: "pour_into", objectId: field("OBJECT"), targetId: field("TARGET"), effector: field("EFFECTOR") });
    case "lab_operate": return compact({ type: "operate", controlId: field("CONTROL"), mode: field("MODE"), value: field("VALUE"), effector: field("EFFECTOR") });
    case "lab_read": return { type: "read_instrument", instrumentId: field("INSTRUMENT") };
    case "lab_record": return { type: "record_observation", fieldId: field("FIELD"), value: field("VALUE") };
    case "lab_drive": return { type: "drive", vx: number(block, "VX"), vy: number(block, "VY"), omega: number(block, "OMEGA"), seconds: number(block, "SECONDS") };
    case "lab_walk": return { type: "humanoid_walk", direction: field("DIRECTION"), steps: number(block, "STEPS"), stepLengthM: number(block, "LENGTH"), speed: number(block, "SPEED") };
    case "lab_turn": return { type: "humanoid_turn", angleDeg: number(block, "ANGLE"), seconds: number(block, "SECONDS") };
    case "lab_posture": return { type: "set_posture", posture: field("POSTURE"), seconds: number(block, "SECONDS") };
    case "lab_pick": return { type: "pick_nearest", hand: field("HAND") };
    case "lab_release": return { type: "release_object", hand: field("HAND") };
    default: throw new Error(`Unsupported Blockly lab block: ${block.type}`);
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== undefined));
}

export function collectBlocklyCommands(workspace) {
  const commands = [];
  const topBlocks = workspace.getTopBlocks(true);
  topBlocks.forEach((top) => {
    let block = top;
    while (block) {
      commands.push(commandFromBlock(block));
      block = block.getNextBlock();
    }
  });
  if (!commands.length) throw new Error("The Blockly workspace does not contain any commands.");
  return commands;
}

function blockShape(command) {
  const commonEffector = command.effector || command.hand || "default";
  const mapping = {
    home: ["lab_home", {}], stop: ["lab_stop", {}], wait: ["lab_wait", { SECONDS: command.seconds }],
    move_to_pose: ["lab_move_to_pose", { POSE: command.poseId, SECONDS: command.seconds }],
    move_joint: ["lab_move_joint", { JOINT: command.joint, VALUE: command.value, SPEED: command.speed }],
    move_joints: ["lab_move_joints", { JOINTS: JSON.stringify(command.joints || {}), SPEED: command.speed }],
    set_gripper: ["lab_gripper", { EFFECTOR: command.effector || command.side || "default", VALUE: command.value || command.mode || "open" }],
    grasp: ["lab_grasp", { OBJECT: command.objectId, EFFECTOR: commonEffector }],
    place: ["lab_place", { OBJECT: command.objectId, ZONE: command.zoneId, EFFECTOR: commonEffector }],
    insert_into: ["lab_insert", { OBJECT: command.objectId, TARGET: command.targetId, EFFECTOR: commonEffector }],
    pour_into: ["lab_pour", { OBJECT: command.objectId, TARGET: command.targetId, EFFECTOR: commonEffector }],
    operate: ["lab_operate", { CONTROL: command.controlId, MODE: command.mode, VALUE: command.value || "", EFFECTOR: commonEffector }],
    read_instrument: ["lab_read", { INSTRUMENT: command.instrumentId }],
    record_observation: ["lab_record", { FIELD: command.fieldId, VALUE: command.value }],
    drive: ["lab_drive", { VX: command.vx, VY: command.vy, OMEGA: command.omega, SECONDS: command.seconds }],
    humanoid_walk: ["lab_walk", { DIRECTION: command.direction, STEPS: command.steps, LENGTH: command.stepLengthM, SPEED: command.speed }],
    humanoid_turn: ["lab_turn", { ANGLE: command.angleDeg, SECONDS: command.seconds }],
    set_posture: ["lab_posture", { POSTURE: command.posture, SECONDS: command.seconds }],
    pick_nearest: ["lab_pick", { HAND: command.hand }],
    release_object: ["lab_release", { HAND: command.hand }]
  };
  return mapping[command.type] || null;
}

export function loadCommandsIntoBlockly(Blockly, workspace, commands) {
  workspace.clear();
  let previous = null;
  (commands || []).forEach((command) => {
    const shape = blockShape(command);
    if (!shape) return;
    const [type, fields] = shape;
    const block = workspace.newBlock(type);
    Object.entries(fields).forEach(([name, value]) => {
      if (value !== undefined && block.getField(name)) block.setFieldValue(String(value), name);
    });
    block.initSvg();
    block.render();
    if (previous && previous.nextConnection && block.previousConnection) previous.nextConnection.connect(block.previousConnection);
    previous = block;
  });
  const first = workspace.getTopBlocks(true)[0];
  if (first) first.moveBy(30, 30);
  Blockly.svgResize(workspace);
}

export function serializeWorkspace(Blockly, workspace) {
  return JSON.stringify(Blockly.serialization.workspaces.save(workspace));
}

export function restoreWorkspace(Blockly, workspace, serialized) {
  if (!serialized) return false;
  Blockly.serialization.workspaces.load(JSON.parse(serialized), workspace);
  return true;
}
