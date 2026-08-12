import { createG1Action, finalG1ActionState, sampleG1Action } from "./actions.js";
import * as calculations from "./calculations.js";
import { G1_HAND_IDS, G1_TOOL_FRAMES } from "./equipment.js";
import { G1_INSTRUCTIONS } from "./instructions.js";
import { createToolFrames, pickNearestObject, releaseObject } from "./interactions.js";
import { G1_LABELS } from "./labels.js";
import { createTaskObjects, resetTaskObjects } from "./objects.js";
import * as state from "./state.js";
import * as steps from "./steps.js";
import { ensureG1Styles, g1StatusText } from "./ui.js";

export const G1_SIMULATION = Object.freeze({
  createG1Action,
  finalG1ActionState,
  sampleG1Action,
  calculations,
  G1_HAND_IDS,
  G1_TOOL_FRAMES,
  G1_INSTRUCTIONS,
  createToolFrames,
  pickNearestObject,
  releaseObject,
  G1_LABELS,
  createTaskObjects,
  resetTaskObjects,
  state,
  steps,
  ensureG1Styles,
  g1StatusText
});
