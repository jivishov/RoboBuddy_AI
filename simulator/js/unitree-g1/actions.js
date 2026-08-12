import { interpolateJoints, interpolateRoot } from "./calculations.js";
import { createDemoKeyframes, createTurnKeyframes, createWalkKeyframes } from "./steps.js";

export function createG1Action(command, state, manifest) {
  if (!command || !state) return null;
  if (command.type === "humanoid_walk") {
    return normalizeAction("humanoid_walk", createWalkKeyframes(command, state));
  }
  if (command.type === "humanoid_turn") {
    return normalizeAction("humanoid_turn", createTurnKeyframes(command, state));
  }
  if (command.type === "set_posture") {
    const posture = manifest && manifest.postures && manifest.postures[command.posture];
    if (!posture) return null;
    return normalizeAction("set_posture", {
      durationSeconds: Number(command.seconds) || 0.8,
      keyframes: [
        { at: 0, root: state.humanoidRoot, joints: state.joints, label: "Starting posture" },
        { at: 1, root: state.humanoidRoot, joints: posture.joints, label: posture.label || command.posture }
      ]
    });
  }
  if (command.type === "run_demo") {
    return normalizeAction("run_demo", createDemoKeyframes(state));
  }
  return null;
}

export function sampleG1Action(action, progress) {
  if (!action || !Array.isArray(action.keyframes) || action.keyframes.length === 0) return null;
  const t = Math.min(1, Math.max(0, Number(progress) || 0));
  let from = action.keyframes[0];
  let to = action.keyframes[action.keyframes.length - 1];
  for (let index = 1; index < action.keyframes.length; index += 1) {
    if (t <= action.keyframes[index].at) {
      from = action.keyframes[index - 1];
      to = action.keyframes[index];
      break;
    }
  }
  const span = Math.max(0.000001, Number(to.at) - Number(from.at));
  const local = Math.min(1, Math.max(0, (t - Number(from.at)) / span));
  return {
    root: interpolateRoot(from.root, to.root, local),
    joints: interpolateJoints(from.joints, to.joints, local),
    label: to.label || from.label || action.id,
    crossedEvent: to.event && t >= Number(to.at) ? to.event : null
  };
}

export function finalG1ActionState(action) {
  if (!action || !action.keyframes || action.keyframes.length === 0) return null;
  const last = action.keyframes[action.keyframes.length - 1];
  return { humanoidRoot: { ...last.root }, joints: { ...last.joints } };
}

function normalizeAction(id, definition) {
  return {
    id,
    durationSeconds: Math.max(0.1, Number(definition.durationSeconds) || 0.1),
    keyframes: definition.keyframes.map((frame) => ({
      ...frame,
      at: Math.min(1, Math.max(0, Number(frame.at) || 0)),
      root: { ...(frame.root || {}) },
      joints: { ...(frame.joints || {}) }
    }))
  };
}


\n