import { commandSubsetMatches } from "./calculations.js";
import { currentCheckpoint, findApparatus, heldObject } from "./state.js";

function rejected(code, message) {
  return { ok: false, code, message };
}

function accepted(message) {
  return { ok: true, code: "CHECKPOINT_ACCEPTED", message };
}

function requiredEffector(definition, expected, command) {
  if (command.hand) return command.hand;
  if (command.effector) return command.effector;
  if (definition.robotId === "openarm_v2_bimanual" && expected.effector) return "";
  return expected.effector || (definition.robotId === "unitree_g1_29dof" ? expected.hand : "default");
}

export function validateCheckpointAction(definition, state, command) {
  const checkpoint = currentCheckpoint(definition, state);
  if (!checkpoint) return rejected("TASK_COMPLETE", "All task checkpoints are already complete.");
  const expected = checkpoint.expected;
  if (!commandSubsetMatches(command, expected)) {
    return rejected("SEQUENCE_MISMATCH", `Next required checkpoint: ${checkpoint.label}.`);
  }
  if (definition.robotId === "openarm_v2_bimanual" && expected.effector && !command.effector) {
    return rejected("EFFECTOR_REQUIRED", `Specify effector=\"${expected.effector}\" for this bimanual checkpoint.`);
  }
  const poseId = expected.requiredPose;
  if (poseId && poseId !== "current" && state.currentPose !== poseId) {
    return rejected("NOT_IN_PROXIMITY", `${checkpoint.label} requires the robot at ${poseId.replace(/_/g, " ")}. Current pose: ${state.currentPose}.`);
  }
  const effector = requiredEffector(definition, expected, command);
  if ((expected.effector || expected.hand) && !effector) {
    return rejected("EFFECTOR_REQUIRED", "Choose the required end effector before manipulating the apparatus.");
  }

  if (command.type === "grasp" || command.type === "pick_nearest") {
    const object = findApparatus(state, expected.objectId);
    if (!object) return rejected("UNKNOWN_OBJECT", `Unknown apparatus: ${expected.objectId}.`);
    if (object.heldBy) return rejected("OBJECT_ALREADY_HELD", `${object.label} is already held by ${object.heldBy}.`);
    if (object.currentZone !== poseId && object.insertedInto === "") {
      return rejected("OBJECT_NOT_HERE", `${object.label} is at ${object.currentZone}, not ${poseId}.`);
    }
    if (state.effectors[effector] && state.effectors[effector].heldObjectId) {
      return rejected("EFFECTOR_OCCUPIED", `${effector.replace(/_/g, " ")} already holds an object.`);
    }
    if (!object.compatibleEffectors.includes(effector)) {
      return rejected("INCOMPATIBLE_EFFECTOR", `${object.label} is not compatible with ${effector.replace(/_/g, " ")}.`);
    }
    if (definition.robotId === "unitree_g1_29dof" && !object.affordances.securedCarrier) {
      return rejected("MORPHOLOGY_LIMIT", "Unitree G1 fixed hands can only attach to secured carriers in these scenarios.");
    }
    if (["hot", "requires cooling gate"].includes(object.state.temperature)) {
      return rejected("THERMAL_GATE", `${object.label} must pass the authored cooling gate before transport.`);
    }
    if (!["none", "none simulated", "clean"].includes(String(object.state.contamination || "").toLowerCase())) {
      return rejected("CONTAMINATION_GATE", `${object.label} is marked ${object.state.contamination}; this task requires a compatible clean handling state.`);
    }
  }

  if (["place", "insert_into", "pour_into", "release_object"].includes(command.type)) {
    const held = heldObject(state, effector);
    if (!held || (expected.objectId && held.id !== expected.objectId)) {
      return rejected("NOT_HOLDING_OBJECT", `${effector.replace(/_/g, " ")} must hold ${expected.objectId || "the required object"}.`);
    }
    if (["place", "release_object"].includes(command.type) && held.allowedZones?.length && !held.allowedZones.includes(expected.zoneId)) {
      return rejected("INCOMPATIBLE_ZONE", `${held.label} cannot be placed in ${expected.zoneId.replace(/_/g, " ")} for this scenario.`);
    }
    if (command.type === "insert_into" && held.orientation !== (held.requiredInsertionOrientation || "upright")) {
      return rejected("INVALID_ORIENTATION", `${held.label} must have the authored ${String(held.requiredInsertionOrientation || "upright").replace(/_/g, " ")} orientation before insertion.`);
    }
    if (command.type === "insert_into") {
      const target = findApparatus(state, expected.targetId);
      if (!target) return rejected("UNKNOWN_TARGET", `Unknown insertion target: ${expected.targetId}.`);
      if (held.compatibleTargets?.length && !held.compatibleTargets.includes(target.id)) {
        return rejected("INCOMPATIBLE_TARGET", `${held.label} is not compatible with ${target.label}.`);
      }
    }
    if (command.type === "pour_into") {
      const target = findApparatus(state, expected.targetId);
      if (!target) return rejected("UNKNOWN_TARGET", `Unknown transfer target: ${expected.targetId}.`);
      if (command.amount !== undefined && command.amount !== null) {
        return rejected("AMOUNT_UNAVAILABLE", "This task models a discrete configured transfer and does not simulate a numeric fluid amount.");
      }
      if (held.compatibleTargets?.length && !held.compatibleTargets.includes(target.id)) {
        return rejected("INCOMPATIBLE_TARGET", `${held.label} is not compatible with ${target.label}.`);
      }
      if (target.affordances?.requiresStabilization && (!target.heldBy || target.heldBy === effector)) {
        return rejected("TARGET_NOT_STABILIZED", `${target.label} must remain secured by the other arm during this transfer.`);
      }
      const vacuum = findApparatus(state, "vacuum_connection");
      if (target.type === "buchner_funnel" && vacuum && vacuum.state.connection !== "connected") {
        return rejected("CONNECTION_GATE", "Connect the authored vacuum line before transferring slurry into the Buchner funnel.");
      }
      if (target.transferState === "full") return rejected("SPILL_RISK", `${target.label} is already at its configured simulated capacity.`);
    }
  }

  if (command.type === "operate") {
    const control = findApparatus(state, expected.controlId);
    if (!control) return rejected("UNKNOWN_CONTROL", `Unknown laboratory control: ${expected.controlId}.`);
    if (!control.affordances?.operable) return rejected("CONTROL_UNAVAILABLE", `${control.label} has no authored operation in this scenario.`);
    if (expected.value !== undefined && command.value !== expected.value) {
      return rejected("INVALID_OPERATION_TARGET", `${checkpoint.label} requires the configured value ${expected.value}.`);
    }
  }

  if (command.type === "read_instrument") {
    const instrument = findApparatus(state, expected.instrumentId);
    if (!instrument || !instrument.affordances?.readable) return rejected("INSTRUMENT_UNAVAILABLE", `${expected.instrumentId} is not an authored readable instrument for this scenario.`);
    if (expected.instrumentId === "spectrophotometer") {
      const inserted = state.apparatus.some((item) => item.insertedInto === "spectrophotometer");
      if (!inserted) return rejected("INSTRUMENT_NOT_READY", "Insert the required cuvette before reading the spectrophotometer.");
    }
    if (expected.instrumentId === "balance") {
      const onBalance = state.apparatus.find((item) => item.currentZone === "balance_zone" && item.type !== "balance");
      if (!onBalance) return rejected("INSTRUMENT_NOT_READY", "Place the required object on the balance before reading its simulated state.");
      if (["hot", "requires cooling gate"].includes(onBalance.state.temperature)) return rejected("THERMAL_GATE", `${onBalance.label} must cool before the balance state can be read.`);
    }
    if (expected.instrumentId === "burette") {
      const funnel = findApparatus(state, "filling_funnel");
      if (funnel && funnel.insertedInto === "burette") return rejected("FUNNEL_NOT_REMOVED", "Remove the filling funnel before reading the burette.");
    }
  }

  if (command.type === "record_observation" && !String(command.value ?? "").trim()) {
    return rejected("EMPTY_OBSERVATION", "Record a non-empty learner observation before completing this checkpoint.");
  }

  return accepted(checkpoint.label);
}

export function completeCheckpoint(definition, state) {
  const checkpoint = currentCheckpoint(definition, state);
  if (!checkpoint) return null;
  state.completedCheckpointIds.push(checkpoint.id);
  state.checkpointIndex += 1;
  if (state.checkpointIndex >= definition.checkpoints.length) state.runState = "complete";
  return checkpoint;
}
