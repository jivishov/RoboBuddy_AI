import { createG1Action, finalG1ActionState, sampleG1Action } from "./actions.js?v=20260812-g1-registration-fix-2";
import * as calculations from "./calculations.js?v=20260812-g1-registration-fix-2";
import { G1_HAND_IDS, G1_TOOL_FRAMES } from "./equipment.js?v=20260812-g1-registration-fix-2";
import { G1_INSTRUCTIONS } from "./instructions.js?v=20260812-g1-registration-fix-2";
import { createToolFrames, pickNearestObject, releaseObject } from "./interactions.js?v=20260812-g1-registration-fix-2";
import { G1_LABELS } from "./labels.js?v=20260812-g1-registration-fix-2";
import { createTaskObjects, resetTaskObjects } from "./objects.js?v=20260812-g1-registration-fix-2";
import * as state from "./state.js?v=20260812-g1-registration-fix-2";
import * as steps from "./steps.js?v=20260812-g1-registration-fix-2";
import { ensureG1Styles, g1StatusText } from "./ui.js?v=20260812-g1-registration-fix-2";

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
