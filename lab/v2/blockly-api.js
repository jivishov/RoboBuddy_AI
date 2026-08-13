import { API_LEVELS } from "./api-contract.js";

const BLOCKS = Object.freeze([
  { type: "v2_observe", level: "guided", message0: "observe lab state", previousStatement: null, nextStatement: null, colour: 165 },
  { type: "v2_transport", level: "guided", message0: "transport object %1 approach %2 contact %3 lift %4 destination %5 retreat %6", args0: ["OBJECT", "APPROACH", "CONTACT", "LIFT", "DESTINATION", "RETREAT"].map((name) => ({ type: "field_input", name, text: name.toLowerCase() })), previousStatement: null, nextStatement: null, colour: 165 },
  { type: "v2_record_evidence", level: "guided", message0: "record evidence %1 value %2", args0: [{ type: "field_input", name: "REQUIREMENT", text: "evidence_id" }, { type: "field_input", name: "VALUE", text: "visible observation" }], previousStatement: null, nextStatement: null, colour: 165 },
  { type: "v2_plan_frame", level: "builder", message0: "plan to frame %1 seed %2", args0: [{ type: "field_input", name: "FRAME", text: "frame_id" }, { type: "field_number", name: "SEED", value: 17, min: 0, precision: 1 }], previousStatement: null, nextStatement: null, colour: 210 },
  { type: "v2_execute_last_plan", level: "builder", message0: "execute last plan", previousStatement: null, nextStatement: null, colour: 210 },
  { type: "v2_replan_frame", level: "builder", message0: "replan to frame %1 alternate seed %2", args0: [{ type: "field_input", name: "FRAME", text: "frame_id" }, { type: "field_number", name: "SEED", value: 101, min: 0, precision: 1 }], previousStatement: null, nextStatement: null, colour: 210 },
  { type: "v2_navigate", level: "builder", message0: "navigate to named frame %1", args0: [{ type: "field_input", name: "FRAME", text: "dock_frame" }], previousStatement: null, nextStatement: null, colour: 210 },
  { type: "v2_repeat", level: "challenge", message0: "repeat %1 times", args0: [{ type: "field_number", name: "COUNT", value: 2, min: 0, max: 20, precision: 1 }], message1: "do %1", args1: [{ type: "input_statement", name: "DO" }], previousStatement: null, nextStatement: null, colour: 285 },
  { type: "v2_if_object_at", level: "challenge", message0: "if object %1 is at frame %2", args0: [{ type: "field_input", name: "OBJECT", text: "object_id" }, { type: "field_input", name: "FRAME", text: "frame_id" }], message1: "do %1", args1: [{ type: "input_statement", name: "DO" }], previousStatement: null, nextStatement: null, colour: 285 },
  { type: "v2_solve_ik", level: "challenge", message0: "solve IK for frame %1 seed %2", args0: [{ type: "field_input", name: "FRAME", text: "frame_id" }, { type: "field_number", name: "SEED", value: 73, min: 0, precision: 1 }], previousStatement: null, nextStatement: null, colour: 285 }
]);

function available(level) {
  return BLOCKS.filter((block) => API_LEVELS[level] >= API_LEVELS[block.level]);
}

export function registerV2Blocks(Blockly) {
  available("challenge").forEach((definition) => {
    if (!Blockly.Blocks[definition.type]) Blockly.Blocks[definition.type] = { init() { this.jsonInit(definition); } };
  });
}

export function createV2Toolbox(level = "guided") {
  const categories = [
    { id: "guided", name: "Guided skills", colour: "#197d74" },
    { id: "builder", name: "Builder planning", colour: "#356d9a" },
    { id: "challenge", name: "Challenge control", colour: "#76529a" }
  ];
  return {
    kind: "categoryToolbox",
    contents: categories.flatMap((category) => {
      const contents = available(level).filter((block) => block.level === category.id).map((block) => ({ kind: "block", type: block.type }));
      return contents.length ? [{ kind: "category", name: category.name, colour: category.colour, contents }] : [];
    })
  };
}

function quote(value) { return JSON.stringify(String(value || "")); }

function blockLine(block, indent, context) {
  const pad = "    ".repeat(indent);
  const field = (name) => block.getFieldValue(name);
  if (block.type === "v2_observe") return [`${pad}observation = await lab.observe()`];
  if (block.type === "v2_transport") return [`${pad}await robot.transport(${quote(field("OBJECT"))}, approach_frame=${quote(field("APPROACH"))}, contact_frame=${quote(field("CONTACT"))}, lift_frame=${quote(field("LIFT"))}, destination_frame=${quote(field("DESTINATION"))}, retreat_frame=${quote(field("RETREAT"))})`];
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

export function compileV2BlocklyProgram(workspace) {
  const top = workspace.getTopBlocks(true);
  if (!top.length) throw new Error("Add at least one ScenarioV2 block before running.");
  const context = { planVariable: "last_plan", branchCounter: 1 };
  const body = top.flatMap((block) => compileChain(block, 1, context));
  return ["async def main(robot, lab):", ...body].join("\n");
}

export const V2_BLOCK_DEFINITIONS = BLOCKS;
