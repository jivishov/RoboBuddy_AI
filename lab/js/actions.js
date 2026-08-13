import { clone, jointPoseMatches, normalizeDegrees, planarDistanceMm, segmentIntersectsCircle } from "./calculations.js";
import { addEvidence, appendCommandLog, createScenarioState, currentCheckpoint, findApparatus, heldObject, setFeedback } from "./state.js";
import { completeCheckpoint, validateCheckpointAction } from "./steps.js";

const NAVIGATION_COMMANDS = new Set(["move_to_pose", "move_joint", "move_joints", "drive", "humanoid_walk", "humanoid_turn", "set_posture", "wait"]);
const FINE_MANIPULATION = new Set(["grasp", "place", "pour_into", "insert_into"]);

function ok(code, message, extra = {}) {
  return { ok: true, code, message, ...extra };
}

function error(code, message) {
  return { ok: false, code, message };
}

function normalizeType(value) {
  const aliases = { insert: "insert_into", pour: "pour_into", read: "read_instrument", record: "record_observation", release: "release_object", walk: "humanoid_walk", turn: "humanoid_turn" };
  const type = String(value || "").trim();
  return aliases[type] || type;
}

function defaultEffector(robotId) {
  if (robotId === "unitree_g1_29dof") return "right_hand";
  if (robotId === "openarm_v2_bimanual") return "";
  return "default";
}

export class LabScenarioEngine {
  constructor(definition, simulationAdapter = null) {
    this.definition = definition;
    this.simulationAdapter = simulationAdapter;
    this.state = createScenarioState(definition);
  }

  reset() {
    this.state = createScenarioState(this.definition);
    if (this.simulationAdapter && typeof this.simulationAdapter.reset === "function") this.simulationAdapter.reset();
    return this.snapshot();
  }

  snapshot() {
    return clone(this.state);
  }

  execute(rawCommand) {
    const command = this.normalizeCommand(rawCommand);
    if (!command.ok) return this.finish(rawCommand || {}, command);
    const value = command.command;
    if (value.type === "stop") return this.finish(value, this.stop());
    if (this.state.stopped) {
      this.state.stopped = false;
      this.state.runState = "ready";
    }

    if (value.type === "home") {
      this.applyHome();
      const checkpoint = currentCheckpoint(this.definition, this.state);
      if (checkpoint && checkpoint.expected.type === "home") {
        const completed = completeCheckpoint(this.definition, this.state);
        addEvidence(this.state, { category: "completion", label: completed.label, value: "Completed", checkpointId: completed.id });
      }
      return this.finish(value, ok(
        this.state.runState === "complete" ? "TASK_COMPLETE" : "HOME",
        this.state.runState === "complete" ? "Task complete. Robot returned to the authored home pose." : "Robot returned to the authored home pose."
      ));
    }
    if (NAVIGATION_COMMANDS.has(value.type)) return this.finish(value, this.executeNavigation(value));

    const prepared = this.prepareManipulationCommand(value);
    if (!prepared.ok) return this.finish(value, prepared);
    const validated = validateCheckpointAction(this.definition, this.state, prepared.command);
    if (!validated.ok) return this.finish(prepared.command, validated);
    this.applyCheckpointMutation(prepared.command);
    const completed = completeCheckpoint(this.definition, this.state);
    addEvidence(this.state, { category: "completion", label: completed.label, value: "Completed", checkpointId: completed.id });
    const message = this.state.runState === "complete" ? "Task complete. All observable checkpoints were satisfied." : `${completed.label} completed.`;
    return this.finish(prepared.command, ok(this.state.runState === "complete" ? "TASK_COMPLETE" : "CHECKPOINT_COMPLETE", message, { checkpointId: completed.id }));
  }

  normalizeCommand(rawCommand) {
    if (!rawCommand || typeof rawCommand !== "object" || Array.isArray(rawCommand)) return error("INVALID_COMMAND", "Command must be an object.");
    const type = normalizeType(rawCommand.type);
    if (!type) return error("INVALID_COMMAND", "Command type is required.");
    if (this.definition.robotId === "unitree_g1_29dof" && FINE_MANIPULATION.has(type)) {
      return error("MORPHOLOGY_LIMIT", "Unitree G1 has fixed hands here. Use pick_nearest and release_object with secured carriers.");
    }
    if (!this.definition.allowedCommands.includes(type) && type !== "move_to_pose" && type !== "stop") {
      return error("COMMAND_NOT_ALLOWED", `${type} is not available for this scenario.`);
    }
    return { ok: true, command: { ...rawCommand, type } };
  }

  prepareManipulationCommand(command) {
    const expected = currentCheckpoint(this.definition, this.state)?.expected || {};
    const next = { ...command };
    if (next.type === "set_gripper") {
      const gripperValue = String(next.value || next.mode || "").toLowerCase();
      const requestedEffector = next.effector || next.side || "";
      if (this.definition.robotId === "openarm_v2_bimanual" && !requestedEffector) {
        return error("EFFECTOR_REQUIRED", "Specify effector=\"left\" or effector=\"right\" for this bimanual gripper command.");
      }
      const effector = requestedEffector || expected.effector || defaultEffector(this.definition.robotId);
      if (["close", "closed", "grasp"].includes(gripperValue) && expected.type === "grasp") {
        return { ok: true, command: { type: "grasp", objectId: expected.objectId, effector, inputCommand: "set_gripper" } };
      }
      if (["open", "opened", "release"].includes(gripperValue) && expected.type === "place") {
        return { ok: true, command: { type: "place", objectId: heldObject(this.state, effector)?.id || "", zoneId: expected.zoneId, effector, inputCommand: "set_gripper" } };
      }
      return error("GRIPPER_CONTEXT", "Gripper close can satisfy the next grasp checkpoint and gripper open can satisfy the next placement checkpoint. Move into proximity first and follow the authored sequence.");
    }
    if (!next.effector && !next.hand) {
      if (this.definition.robotId === "openarm_v2_bimanual" && expected.effector) {
        return error("EFFECTOR_REQUIRED", `Specify effector=\"${expected.effector}\" for this bimanual checkpoint.`);
      }
      if (expected.hand) next.hand = expected.hand;
      else next.effector = expected.effector || defaultEffector(this.definition.robotId);
    }
    const effector = next.hand || next.effector;
    if (next.type === "pick_nearest" && !next.objectId) next.objectId = expected.objectId;
    if (["place", "insert_into", "pour_into"].includes(next.type) && !next.objectId) {
      next.objectId = heldObject(this.state, effector)?.id || "";
    }
    if (next.type === "release_object") {
      if (!next.objectId) next.objectId = heldObject(this.state, effector)?.id || "";
      if (!next.zoneId) next.zoneId = expected.zoneId;
    }
    if (next.type === "place" && !next.zoneId) next.zoneId = expected.zoneId;
    if (next.type === "insert_into" && !next.targetId) next.targetId = expected.targetId;
    if (next.type === "pour_into" && !next.targetId) next.targetId = expected.targetId;
    return { ok: true, command: next };
  }

  executeNavigation(command) {
    if (command.type === "wait") {
      const seconds = Number(command.seconds);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) return error("INVALID_WAIT", "Wait must be between 0 and 30 simulated seconds.");
      return ok("WAIT", `Simulated wait accepted (${seconds} s configured).`);
    }
    if (command.type === "move_to_pose") {
      const seconds = Number(command.seconds ?? 1.2);
      if (!Number.isFinite(seconds) || seconds < 0.2 || seconds > 10) return error("POSE_DURATION_LIMIT", "Named-pose motion must use 0.2 to 10 simulated seconds.");
      const pose = this.definition.robotPoses[command.poseId];
      if (!pose) return error("UNKNOWN_POSE", `Unknown scenario pose: ${command.poseId}.`);
      if (!pose.helperAvailable) return error("HELPER_UNAVAILABLE", `${pose.label} is not exposed at this assistance level. Use low-level robot motion.`);
      const jointValidation = this.validateJointUpdates(pose.joints || {});
      if (!jointValidation.ok) return jointValidation;
      const startPosition = [...this.state.basePositionMm];
      const startHeading = this.state.headingDeg;
      const hazard = this.navigationHazard(startPosition, pose.positionMm || startPosition);
      if (hazard) return error("HAZARD_ZONE", `The direct route to ${pose.label} intersects ${hazard.label}. Use a safe intermediate route.`);
      this.applyPoseToSimulation(pose, startPosition, startHeading);
      this.state.currentPose = pose.id;
      this.state.robotJoints = { ...this.state.robotJoints, ...jointValidation.updates };
      this.state.basePositionMm = [...(pose.positionMm || this.state.basePositionMm)];
      if (this.definition.robotId === "unitree_g1_29dof" && planarDistanceMm(startPosition, this.state.basePositionMm) > 0.5) {
        this.state.headingDeg = normalizeDegrees(Math.atan2(this.state.basePositionMm[2] - startPosition[2], this.state.basePositionMm[0] - startPosition[0]) * 180 / Math.PI);
      }
      return ok("POSE_REACHED", `${pose.label} reached within its authored kinematic pose envelope.`);
    }
    if (command.type === "move_joint" || command.type === "move_joints") {
      const speed = Number(command.speed ?? 45);
      if (!Number.isFinite(speed) || speed < 1 || speed > 100) return error("JOINT_SPEED_LIMIT", "Joint speed must be from 1 to 100 percent.");
      const updates = command.type === "move_joint" ? { [command.joint]: Number(command.value) } : command.joints;
      if (!updates || typeof updates !== "object") return error("INVALID_JOINT_COMMAND", "Provide a joint target object.");
      const validated = this.validateJointUpdates(updates);
      if (!validated.ok) return validated;
      const simulationCommand = command.type === "move_joint"
        ? { ...command, value: validated.updates[command.joint] }
        : { ...command, joints: validated.updates };
      this.applySimulationCommand(simulationCommand);
      this.state.robotJoints = { ...this.state.robotJoints, ...validated.updates };
      const matched = Object.values(this.definition.robotPoses).find((pose) => jointPoseMatches(this.state.robotJoints, pose.joints, pose.tolerance?.jointDeg || 2.5));
      this.state.currentPose = matched ? matched.id : "custom";
      return ok(matched ? "POSE_REACHED" : "JOINTS_UPDATED", matched ? `${matched.label} reached by low-level joint targets.` : "Joint targets updated; no task pose is within tolerance.");
    }
    if (command.type === "drive") {
      if (this.definition.robotId !== "lekiwi_sim") return error("MORPHOLOGY_LIMIT", "Drive is only available for LeKiwi tasks.");
      if (command.destinationId && !this.definition.robotPoses[command.destinationId]) {
        return error("UNKNOWN_DESTINATION", `Unknown route destination: ${command.destinationId}.`);
      }
      const seconds = Number(command.seconds);
      const vx = Number(command.vx);
      const vy = Number(command.vy);
      const omega = Number(command.omega || 0);
      const speed = Math.hypot(vx, vy);
      const maxSpeed = Number(this.simulationAdapter?.manifest?.mobileBase?.maxLinearSpeed || 1);
      const maxOmega = Number(this.simulationAdapter?.manifest?.mobileBase?.maxAngularSpeed || 90);
      if (![seconds, vx, vy, omega].every(Number.isFinite) || seconds <= 0 || seconds > 30) return error("INVALID_DRIVE", "Drive requires finite velocities and a duration from 0 to 30 seconds.");
      if (command.frame !== undefined && !["robot", "world"].includes(command.frame)) return error("INVALID_DRIVE_FRAME", "Drive frame must be robot or world.");
      if (speed > maxSpeed || Math.abs(omega) > maxOmega) return error("DRIVE_LIMIT", `LeKiwi drive must remain within ${maxSpeed} m/s and ${maxOmega} deg/s.`);
      const start = [...this.state.basePositionMm];
      const theta = this.state.headingDeg * Math.PI / 180;
      const worldVx = command.frame === "world" ? vx : vx * Math.cos(theta) - vy * Math.sin(theta);
      const worldVz = command.frame === "world" ? vy : vx * Math.sin(theta) + vy * Math.cos(theta);
      const end = [start[0] + worldVx * seconds * 1000, start[1], start[2] + worldVz * seconds * 1000];
      const hazard = this.navigationHazard(start, end);
      if (hazard) return error("HAZARD_ZONE", `Drive rejected: the segment intersects ${hazard.label}. Route around the authored no-entry volume.`);
      this.applySimulationCommand(command);
      this.state.basePositionMm = end;
      this.state.headingDeg = normalizeDegrees(this.state.headingDeg + omega * seconds);
      return this.finishMobileNavigation(command.destinationId, "driving");
    }
    if (command.type === "humanoid_walk") {
      if (this.definition.robotId !== "unitree_g1_29dof") return error("MORPHOLOGY_LIMIT", "Humanoid walking is only available for Unitree G1 tasks.");
      if (command.destinationId && !this.definition.robotPoses[command.destinationId]) {
        return error("UNKNOWN_DESTINATION", `Unknown route destination: ${command.destinationId}.`);
      }
      const steps = Number(command.steps);
      const stepLengthM = Number(command.stepLengthM ?? command.step_length_m);
      const speed = Number(command.speed ?? 45);
      if (!Number.isInteger(steps) || steps < 1 || steps > 20 || !Number.isFinite(stepLengthM) || stepLengthM < 0.02 || stepLengthM > 0.12) {
        return error("WALK_LIMIT", "G1 walking requires 1-20 whole steps with a configured step length from 0.02 m to 0.12 m.");
      }
      if (!Number.isFinite(speed) || speed < 1 || speed > 100) return error("WALK_SPEED_LIMIT", "G1 walk speed must be from 1 to 100 percent.");
      if (!["forward", "backward"].includes(command.direction)) return error("INVALID_WALK", "G1 walk direction must be forward or backward.");
      const signedDistanceMm = steps * stepLengthM * 1000 * (command.direction === "backward" ? -1 : 1);
      const radians = this.state.headingDeg * Math.PI / 180;
      const start = [...this.state.basePositionMm];
      const end = [start[0] + signedDistanceMm * Math.cos(radians), start[1], start[2] + signedDistanceMm * Math.sin(radians)];
      const hazard = this.navigationHazard(start, end);
      if (hazard) return error("HAZARD_ZONE", `Walk rejected: the segment enters ${hazard.label}. Turn and use a safe intermediate route.`);
      this.applySimulationCommand(command);
      this.state.basePositionMm = end;
      return this.finishMobileNavigation(command.destinationId, "scripted walking");
    }
    if (command.type === "humanoid_turn") {
      if (this.definition.robotId !== "unitree_g1_29dof") return error("MORPHOLOGY_LIMIT", `${command.type} is only available for Unitree G1 tasks.`);
      const angle = Number(command.angleDeg);
      const seconds = Number(command.seconds ?? 1.5);
      if (!Number.isFinite(angle) || Math.abs(angle) > 180) return error("TURN_LIMIT", "G1 turn angle must be between -180 and 180 degrees.");
      if (!Number.isFinite(seconds) || seconds < 0.2 || seconds > 10) return error("TURN_DURATION_LIMIT", "G1 turn duration must be from 0.2 to 10 simulated seconds.");
      this.applySimulationCommand(command);
      this.state.headingDeg = normalizeDegrees(this.state.headingDeg + angle);
      return ok("KINEMATIC_MOTION", `Humanoid turn completed; authored heading is ${this.state.headingDeg.toFixed(1)} deg.`);
    }
    if (command.type === "set_posture") {
      if (this.definition.robotId !== "unitree_g1_29dof") return error("MORPHOLOGY_LIMIT", `${command.type} is only available for Unitree G1 tasks.`);
      const knownPostures = Object.keys(this.simulationAdapter?.manifest?.postures || { neutral: true, work_reach: true });
      const seconds = Number(command.seconds ?? 0.8);
      if (!knownPostures.includes(command.posture)) return error("UNKNOWN_POSTURE", `Unknown G1 posture: ${command.posture}.`);
      if (!Number.isFinite(seconds) || seconds < 0.2 || seconds > 10) return error("POSTURE_DURATION_LIMIT", "G1 posture duration must be from 0.2 to 10 simulated seconds.");
      this.applySimulationCommand(command);
      return ok("KINEMATIC_MOTION", "Set posture completed as a scripted kinematic visualization.");
    }
    return error("UNSUPPORTED_NAVIGATION", `Unsupported navigation command: ${command.type}.`);
  }

  validateJointUpdates(updates) {
    const manifestJoints = this.simulationAdapter?.manifest?.joints || [];
    const poseJointIds = new Set(Object.values(this.definition.robotPoses || {}).flatMap((pose) => Object.keys(pose.joints || {})));
    const normalized = {};
    for (const [jointId, value] of Object.entries(updates || {})) {
      const joint = manifestJoints.find((candidate) => candidate.id === jointId);
      if (!joint && !poseJointIds.has(jointId)) return error("UNKNOWN_JOINT", `Unknown joint: ${jointId}.`);
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return error("INVALID_JOINT_COMMAND", `${jointId} requires a finite numeric value.`);
      if (joint && (numeric < Number(joint.min) || numeric > Number(joint.max))) {
        return error("JOINT_LIMIT", `${joint.label} must remain between ${joint.min} and ${joint.max} ${joint.unit}.`);
      }
      normalized[jointId] = numeric;
    }
    return { ok: true, updates: normalized };
  }

  navigationHazard(start, end) {
    return (this.definition.navigationHazards || []).find((hazard) => segmentIntersectsCircle(start, end, hazard.centerMm, hazard.radiusMm)) || null;
  }

  finishMobileNavigation(destinationId, motionLabel) {
    const destination = destinationId ? this.definition.robotPoses[destinationId] : null;
    if (destinationId && !destination) return error("UNKNOWN_DESTINATION", `Unknown route destination: ${destinationId}.`);
    const poses = destination ? [destination] : Object.values(this.definition.robotPoses);
    const matched = poses.find((pose) => planarDistanceMm(this.state.basePositionMm, pose.positionMm) <= Number(pose.tolerance?.positionMm || 35));
    this.state.currentPose = matched ? matched.id : "route";
    if (matched) return ok("STATION_REACHED", `${matched.label} reached by ${motionLabel}; position tolerance satisfied.`);
    const remaining = destination ? planarDistanceMm(this.state.basePositionMm, destination.positionMm) : null;
    return ok("ROUTE_PROGRESS", remaining === null ? `${motionLabel} updated the authored base position.` : `${motionLabel} route incomplete; ${remaining.toFixed(0)} mm remain to ${destination.label}.`);
  }

  applyCheckpointMutation(command) {
    const effector = command.hand || command.effector || defaultEffector(this.definition.robotId);
    if (command.type === "grasp" || command.type === "pick_nearest") {
      const object = findApparatus(this.state, command.objectId);
      object.heldBy = effector;
      object.currentZone = "";
      object.insertedInto = "";
      this.state.effectors[effector].heldObjectId = object.id;
      this.setSimulatedGripper(effector, "close");
      return;
    }
    if (command.type === "place" || command.type === "release_object") {
      const object = heldObject(this.state, effector);
      object.heldBy = "";
      object.currentZone = command.zoneId;
      object.insertedInto = "";
      this.state.effectors[effector].heldObjectId = "";
      this.setSimulatedGripper(effector, "open");
      return;
    }
    if (command.type === "insert_into") {
      const object = heldObject(this.state, effector);
      const target = findApparatus(this.state, command.targetId);
      object.heldBy = "";
      object.currentZone = target.currentZone;
      object.insertedInto = target.id;
      this.state.effectors[effector].heldObjectId = "";
      this.setSimulatedGripper(effector, "open");
      return;
    }
    if (command.type === "pour_into") {
      const source = heldObject(this.state, effector);
      const target = findApparatus(this.state, command.targetId);
      source.transferState = "transferred";
      target.transferState = "received configured transfer";
      addEvidence(this.state, { category: "simulator-generated", label: "Discrete transfer state", value: `${source.label} to ${target.label}` });
      return;
    }
    if (command.type === "operate") {
      const control = findApparatus(this.state, command.controlId);
      if (control) control.operationState[command.mode] = command.value ?? true;
      if (["cool", "confirm_cooled"].includes(command.mode) && command.value) {
        const cooled = findApparatus(this.state, command.value);
        if (cooled) cooled.state.temperature = "cooled";
      }
      if (command.mode === "connect" && control) control.state.connection = "connected";
      addEvidence(this.state, { category: "simulator-generated", label: `${control ? control.label : command.controlId} state`, value: command.mode.replace(/_/g, " ") });
      return;
    }
    if (command.type === "read_instrument") {
      addEvidence(this.state, { category: "simulator-generated", label: `${command.instrumentId.replace(/_/g, " ")} state`, value: "Simulated ready state; no numeric measurement generated" });
      return;
    }
    if (command.type === "record_observation") {
      addEvidence(this.state, { category: "learner-recorded", label: command.fieldId.replace(/_/g, " "), value: String(command.value ?? "") });
    }
  }

  applyHome() {
    const home = this.definition.robotPoses.home || { joints: {}, positionMm: [0, 0, 0] };
    this.state.currentPose = "home";
    this.state.robotJoints = { ...(home.joints || {}) };
    this.state.basePositionMm = [...(home.positionMm || [0, 0, 0])];
    this.state.headingDeg = 0;
    if (this.simulationAdapter && typeof this.simulationAdapter.home === "function") this.simulationAdapter.home();
  }

  applyPoseToSimulation(pose, startPosition = this.state.basePositionMm, startHeading = this.state.headingDeg) {
    if (!this.simulationAdapter) return;
    const target = pose.positionMm || startPosition;
    const deltaX = Number(target[0]) - Number(startPosition[0]);
    const deltaZ = Number(target[2]) - Number(startPosition[2]);
    const distanceMm = Math.hypot(deltaX, deltaZ);
    if (this.definition.robotId === "lekiwi_sim") {
      if (distanceMm > 0.5) {
        const seconds = Math.max(0.5, Math.min(3, distanceMm / 350));
        this.applySimulationCommand({
          type: "drive",
          vx: deltaX / 1000 / seconds,
          vy: deltaZ / 1000 / seconds,
          omega: 0,
          seconds,
          frame: "world",
          destinationId: pose.id
        });
      }
      if (Object.keys(pose.joints || {}).length) this.applySimulationCommand({ type: "move_joints", joints: pose.joints, speed: 45 });
      return;
    }
    if (this.definition.robotId === "unitree_g1_29dof") {
      if (distanceMm > 0.5) {
        const targetHeading = Math.atan2(deltaZ, deltaX) * 180 / Math.PI;
        const turnAngle = normalizeDegrees(targetHeading - startHeading);
        if (Math.abs(turnAngle) > 0.5) this.applySimulationCommand({ type: "humanoid_turn", angleDeg: turnAngle, seconds: 1.2 });
        const steps = Math.max(1, Math.ceil(distanceMm / 120));
        this.applySimulationCommand({
          type: "humanoid_walk",
          direction: "forward",
          steps,
          stepLengthM: distanceMm / steps / 1000,
          speed: 45,
          destinationId: pose.id
        });
      }
      this.applySimulationCommand({ type: "set_posture", posture: pose.id === "home" ? "neutral" : "work_reach", seconds: 0.8 });
      return;
    }
    if (Object.keys(pose.joints || {}).length) this.applySimulationCommand({ type: "move_joints", joints: pose.joints, speed: 45 });
  }

  applySimulationCommand(command) {
    if (this.simulationAdapter && typeof this.simulationAdapter.applyCommand === "function") {
      this.simulationAdapter.applyCommand(command);
    }
  }

  setSimulatedGripper(effector, value) {
    if (!this.simulationAdapter || this.definition.robotId === "unitree_g1_29dof") return;
    const grippers = this.simulationAdapter.manifest.joints.filter((joint) => {
      if (joint.type !== "gripper") return false;
      if (this.definition.robotId !== "openarm_v2_bimanual") return true;
      return joint.side === effector || joint.id.startsWith(`${effector}_`);
    });
    const joints = Object.fromEntries(grippers.map((joint) => [joint.id, value === "open" ? joint.open : joint.close]));
    if (Object.keys(joints).length) this.applySimulationCommand({ type: "set_gripper", joints, speed: 45, side: effector });
  }

  stop() {
    this.state.stopped = true;
    this.state.runState = "stopped";
    if (this.simulationAdapter && typeof this.simulationAdapter.stop === "function") this.simulationAdapter.stop();
    return ok("STOPPED", "Queued robot and scene motion stopped. Scenario state is preserved for recovery.");
  }

  finish(command, result) {
    setFeedback(this.state, result.ok ? (result.code === "TASK_COMPLETE" ? "success" : "ready") : "error", result.code, result.message);
    appendCommandLog(this.state, command, result);
    return { ...result, state: this.snapshot() };
  }
}
