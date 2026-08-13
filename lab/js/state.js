import { clone } from "./calculations.js";

function initialEffectors(robotId) {
  if (robotId === "openarm_v2_bimanual") return { left: { heldObjectId: "" }, right: { heldObjectId: "" } };
  if (robotId === "unitree_g1_29dof") return { left_hand: { heldObjectId: "" }, right_hand: { heldObjectId: "" } };
  return { default: { heldObjectId: "" } };
}

export function createScenarioState(definition) {
  const home = definition.robotPoses.home || { joints: {} };
  return {
    schema: "robobuddy.lab-runtime-state.v1",
    scenarioId: definition.id,
    robotId: definition.robotId,
    runState: "ready",
    stopped: false,
    currentPose: "home",
    basePositionMm: [...(home.positionMm || [0, 0, 0])],
    headingDeg: 0,
    routeProgressM: 0,
    checkpointIndex: 0,
    completedCheckpointIds: [],
    robotJoints: clone(home.joints || {}),
    effectors: initialEffectors(definition.robotId),
    apparatus: definition.apparatus.map((item) => ({
      ...clone(item),
      currentZone: item.initialZone,
      heldBy: "",
      insertedInto: "",
      operationState: {},
      transferState: "unchanged",
      removed: false
    })),
    evidence: [{
      id: "scenario-configured",
      category: "configured",
      label: "Scenario configuration loaded",
      value: `${definition.title} · Rank ${definition.rank}`,
      checkpointId: "",
      timestamp: new Date().toISOString()
    }],
    feedback: {
      tone: "ready",
      code: "READY",
      message: "Task state is ready. Load a starter or author a program."
    },
    commandLog: []
  };
}

export function resetScenarioState(definition) {
  return createScenarioState(definition);
}

export function currentCheckpoint(definition, state) {
  return definition.checkpoints[state.checkpointIndex] || null;
}

export function findApparatus(state, objectId) {
  return state.apparatus.find((item) => item.id === objectId) || null;
}

export function heldObject(state, effector) {
  const heldObjectId = state.effectors[effector] && state.effectors[effector].heldObjectId;
  return heldObjectId ? findApparatus(state, heldObjectId) : null;
}

export function addEvidence(state, entry) {
  state.evidence.push({
    id: `evidence-${state.evidence.length + 1}`,
    timestamp: new Date().toISOString(),
    checkpointId: "",
    ...entry
  });
}

export function setFeedback(state, tone, code, message) {
  state.feedback = { tone, code, message };
}

export function appendCommandLog(state, command, result) {
  state.commandLog.push({
    index: state.commandLog.length + 1,
    command: clone(command),
    ok: Boolean(result.ok),
    code: result.code || (result.ok ? "OK" : "ERROR"),
    message: result.message || "",
    timestamp: new Date().toISOString()
  });
}
