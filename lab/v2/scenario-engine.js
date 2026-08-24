import { assertApiMethod } from "./api-contract.js";
import { describePredicate, evaluateEvidenceRequirement, evaluatePredicate, gradeScenario } from "./grading.js";
import { forwardKinematics, inverseKinematics } from "./kinematics.js?v=20260823-physical-fidelity-3";
import { composeTransform, deepClone, distance3, dot3, inverseTransform, normalize3, rotate3, transposeRotation } from "./math.js?v=20260823-physical-fidelity-3";
import { planJointPath, planOccupancyGridAStar, requireStowedForDrive } from "./planner.js?v=20260823-physical-fidelity-3";
import { PortableRobotPlant } from "./portable-robot-plant.js?v=20260823-physical-fidelity-5";
import { compatibilityProfile } from "./python-compatibility-catalog.js";
import { proxiesCollide, stateCollisionReport } from "./collision.js?v=20260823-physical-fidelity-5";
import { homeJointState, loadRobotModel } from "./robot-model-catalog.js?v=20260823-physical-fidelity-5";
import { SO101_COMMAND_MODEL, so101ActionToJointState, so101JointStateToAction, validateSo101Action } from "./so101-command-model.js?v=20260816-so101-partial-actions-1";
import { assertScenarioV2 } from "./scenario-schema.js?v=20260823-physical-fidelity-3";
import { buildContactSequence, TrajectoryExecutor } from "./trajectory-executor.js";
import { initialObjectPose, physicalObjectProxy, WORLD_UP } from "./physical-rest.js?v=20260823-physical-fidelity-3";
import { G1_CARRY_ARMS, G1_NEUTRAL_LEGS, gaitPose } from "../../simulator/js/unitree-g1/steps.js?v=20260812-g1-registration-fix-2";

const G1_NEUTRAL_ARMS = Object.freeze(Object.fromEntries(Object.keys(G1_CARRY_ARMS).map((jointId) => [jointId, 0])));

function g1LogisticsPose({ walking, turning, leftLead, carrying, turnDirection }) {
  const arms = carrying ? G1_CARRY_ARMS : G1_NEUTRAL_ARMS;
  if (walking) {
    const pose = gaitPose(leftLead, carrying);
    const strideScale = 0.55;
    return {
      ...pose,
      ...arms,
      left_hip_pitch_joint: pose.left_hip_pitch_joint * strideScale,
      left_knee_joint: pose.left_knee_joint * strideScale,
      left_ankle_pitch_joint: pose.left_ankle_pitch_joint * strideScale,
      left_hip_roll_joint: pose.left_hip_roll_joint * strideScale,
      right_hip_pitch_joint: pose.right_hip_pitch_joint * strideScale,
      right_knee_joint: pose.right_knee_joint * strideScale,
      right_ankle_pitch_joint: pose.right_ankle_pitch_joint * strideScale,
      right_hip_roll_joint: pose.right_hip_roll_joint * strideScale,
      waist_yaw_joint: pose.waist_yaw_joint * strideScale,
      ...(carrying ? {} : {
        left_shoulder_pitch_joint: pose.left_shoulder_pitch_joint * 0.5,
        right_shoulder_pitch_joint: pose.right_shoulder_pitch_joint * 0.5,
        left_elbow_joint: 5,
        right_elbow_joint: 5
      })
    };
  }
  if (turning) return {
    ...G1_NEUTRAL_LEGS,
    ...arms,
    left_knee_joint: 14,
    right_knee_joint: 14,
    left_hip_yaw_joint: turnDirection >= 0 ? -22 : 22,
    right_hip_yaw_joint: turnDirection >= 0 ? 22 : -22,
    left_ankle_pitch_joint: -5,
    right_ankle_pitch_joint: -5
  };
  return { ...G1_NEUTRAL_LEGS, ...arms };
}

function result(ok, code, message, extra = {}) { return { ok, code, message, ...extra }; }
function failure(code, message, extra = {}) { return result(false, code, message, extra); }
function success(code, message, extra = {}) { return result(true, code, message, extra); }

function objectMap(definition) {
  return Object.fromEntries(definition.objects.map((item) => {
    const pose = initialObjectPose(item);
    return [item.id, {
      ...deepClone(item),
      currentFrame: item.initialFrame,
      attachedTo: "",
      configuredAttachmentInterface: item.attachmentInterface || "",
      attachmentInterface: "",
      attachmentTransform: null,
      graspConstraint: null,
      freeFallVelocityMmPerS: [0, 0, 0],
      releasedUnsupported: false,
      worldPositionMm: pose ? [...pose.positionMm] : undefined,
      worldRotationMatrix: pose ? [...pose.rotationMatrix] : undefined,
      state: deepClone(item.initialState || {})
    }];
  }));
}

function processMap(definition) {
  return Object.fromEntries(definition.processModels.map((item) => [item.id, {
    id: item.id,
    state: item.initialState || "ready",
    commits: 0,
    fixtureId: item.fixtureId || "",
    objectId: ""
  }]));
}

const FRAME_PLAN_ATTEMPTS = Object.freeze([
  { offset: 0, minimumStarts: 0, maxIterations: null, openArmProfile: "stable" },
  { offset: 1009, minimumStarts: 12, maxIterations: 700, openArmProfile: "stable" },
  { offset: 2027, minimumStarts: 16, maxIterations: 700, openArmProfile: "fixed-base" },
  { offset: 4093, minimumStarts: 20, maxIterations: 1600, openArmProfile: "full" }
]);

function activeJointsForAttempt(model, jointIds, profile) {
  if (model.id !== "openarm_v2_bimanual") return jointIds;
  if (profile === "stable") return jointIds.filter((jointId) => jointId !== "base_yaw" && !/_j[57]$/.test(jointId));
  if (profile === "fixed-base") return jointIds.filter((jointId) => jointId !== "base_yaw");
  // The 550 mm turntable is simulator-specific morphology, not an OpenArm
  // source-pattern joint. Even the final reachability fallback must keep it
  // fixed; wrist freedom may relax only within the physical arm chain.
  return jointIds.filter((jointId) => jointId !== "base_yaw");
}

function missingDetails(predicates) {
  return { missing: predicates, missingDescriptions: predicates.map(describePredicate) };
}

function initialState(definition, model) {
  return {
    schema: "robobuddy.lab-runtime-state.v2",
    scenarioId: definition.id,
    robotId: definition.robotId,
    runState: "ready",
    rootPose: { positionMm: [0, 0, 0], headingDeg: 0 },
    jointState: homeJointState(model),
    lastReachedFrame: "home",
    visitedFrames: ["home"],
    objects: objectMap(definition),
    processes: processMap(definition),
    evidence: [],
    eventLog: [],
    commandLog: [],
    lastAction: model.id === "so101_follower" ? so101JointStateToAction(homeJointState(model)) : null,
    calibrationStatus: model.id === "so101_follower" ? SO101_COMMAND_MODEL.calibration.simulationStatus : "not_applicable",
    fixedRootViolation: false,
    feedback: { tone: "ready", code: "READY", message: "Scenario v2 is ready." }
  };
}

export function initialPhysicalOverlapReport(definition, model, jointState = homeJointState(model)) {
  const objects = (definition.objects || []).flatMap((item) => {
    const pose = initialObjectPose(item);
    const proxy = pose ? physicalObjectProxy(item, { position: pose.positionMm, rotation: pose.rotationMatrix }) : null;
    return proxy ? [{ item, proxy: { ...proxy, id: `object:${item.id}` } }] : [];
  });
  const robotCollisions = objects.flatMap(({ item, proxy }) => {
    const report = stateCollisionReport(model, jointState, [proxy], {
      basePose: { positionMm: [0, 0, 0], headingDeg: 0 },
      contactSurfaceClearanceMm: 0,
    });
    return report.collisions.map((collision) => ({ ...collision, objectId: item.id }));
  });
  const objectCollisions = [];
  for (let left = 0; left < objects.length; left += 1) {
    for (let right = left + 1; right < objects.length; right += 1) {
      if (proxiesCollide(objects[left].proxy, objects[right].proxy)) {
        objectCollisions.push({ objectId: objects[left].item.id, otherObjectId: objects[right].item.id });
      }
    }
  }
  return {
    ok: robotCollisions.length === 0 && objectCollisions.length === 0,
    robotCollisions,
    objectCollisions,
  };
}

function frameObstacles(definition, excludedFixtureId = "", options = {}) {
  const strictPortableCollision = ["so101_follower", "lekiwi_sim", "openarm_v2_bimanual"].includes(definition.robotId);
  return definition.fixtures.flatMap((fixture) => {
    if (!strictPortableCollision && fixture.id === excludedFixtureId) return [];
    const proxies = Array.isArray(fixture.collisionProxies)
      ? fixture.collisionProxies
      : fixture.collisionProxy ? [fixture.collisionProxy] : [];
    return proxies.filter((proxy) => (
      proxy.planningRole !== "robot_mount_contact"
      && (strictPortableCollision || options.includeContactSurfaces === true || proxy.planningRole !== "contact_surface")
    )).map((proxy, index) => ({
      id: `${fixture.id}:${proxy.id || index + 1}`,
      ...deepClone(proxy)
    }));
  });
}

function appendEventsToFinal(path, events = [], phase = "motion") {
  const samples = path.map((jointState) => ({ jointState: deepClone(jointState), phase }));
  if (!samples.length) return [];
  samples.at(-1).events = deepClone(events);
  return samples;
}

function interpolateJointStates(start, target, steps = 5) {
  const count = Math.max(1, Math.min(60, Math.floor(Number(steps) || 1)));
  return Array.from({ length: count }, (_, index) => {
    const progress = (index + 1) / count;
    return Object.fromEntries(Object.keys(target).map((jointId) => [
      jointId,
      Number(start[jointId] ?? 0) + (Number(target[jointId]) - Number(start[jointId] ?? 0)) * progress
    ]));
  });
}

function tagCompiledAction(samples, phase, explanation) {
  if (!samples.length) return samples;
  samples.at(-1).compiledAction = {
    method: "robot.send_action",
    phase,
    action: so101JointStateToAction(samples.at(-1).jointState),
    explanation
  };
  return samples;
}

function markReachedFrame(samples, frameId) {
  if (samples.length) samples.at(-1).reachedFrame = frameId;
  return samples;
}

function uprightPayloadConstraint(model, jointState, chainId, basePose, toleranceDeg = 2) {
  const rotation = forwardKinematics(model, jointState, { chainId, basePose }).transform.rotation;
  return {
    localVector: rotate3(transposeRotation(rotation), WORLD_UP),
    targetVector: [...WORLD_UP],
    toleranceDeg,
    weightMmPerRad: 140,
  };
}

function directionConstraintSatisfied(model, jointState, chainId, basePose, constraint, extraToleranceDeg = 0.5) {
  if (!constraint) return true;
  const rotation = forwardKinematics(model, jointState, { chainId, basePose }).transform.rotation;
  const vectors = [
    [constraint.localVector, constraint.targetVector],
    [constraint.secondaryLocalVector, constraint.secondaryTargetVector],
  ].filter(([local, target]) => local && target);
  return vectors.every(([local, target]) => {
    const actual = normalize3(rotate3(rotation, local));
    const expected = normalize3(target);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot3(actual, expected)))) * 180 / Math.PI;
    return angle <= Number(constraint.toleranceDeg || 2) + extraToleranceDeg;
  });
}

export class ScenarioV2Engine {
  static async create(definition, options = {}) {
    // Generated browser scenarios intentionally omit validation-only reference
    // executions. Authored sources still use the strict default validator.
    assertScenarioV2(definition, { requireValidation: definition.validationAvailable !== true });
    const model = await loadRobotModel(definition.robotId);
    if (definition.canonicalModel.sourceRevision !== model.source.revision) {
      throw new Error(`Scenario model revision ${definition.canonicalModel.sourceRevision} does not match ${model.source.revision}.`);
    }
    return new ScenarioV2Engine(definition, model, options);
  }

  constructor(definition, model, options = {}) {
    this.definition = deepClone(definition);
    this.model = model;
    this.options = options;
    this.state = initialState(this.definition, this.model);
    const initialOverlap = initialPhysicalOverlapReport(this.definition, this.model, this.state.jointState);
    if (!initialOverlap.ok) {
      throw new Error(`Scenario ${definition.id} has a physical overlap before the first command: ${JSON.stringify(initialOverlap)}`);
    }
    this.baseline = deepClone(this.state);
    this.plans = new Map();
    this.planCounter = 0;
    this.stateGeneration = 0;
    this.executor = new TrajectoryExecutor({
      baseline: { jointState: this.state.jointState, rootPose: this.state.rootPose },
      sleep: options.sleep,
      onSample: async (sample, index) => this.applyTrajectorySample(sample, index),
      onEvent: async (event, sample, index) => this.applyEvent(event, { sample, index })
    });
    this.createPortablePlant();
  }

  createPortablePlant() {
    this.plant?.dispose?.();
    const portable = ["so101_follower", "lekiwi_sim", "openarm_v2_bimanual"].includes(this.model.id);
    this.plant = portable ? new PortableRobotPlant({
      definition: this.definition,
      model: this.model,
      runtimeState: this.state,
      autoStart: this.options.autoStartPlant === true,
      onTick: (_plant, state) => this.options.onSample?.({ phase: "portable_plant_tick", jointState: deepClone(state.jointState), rootPose: deepClone(state.rootPose) }, -1, this.snapshot())
    }) : null;
  }

  snapshot() {
    const snapshot = deepClone(this.state);
    snapshot.robotJoints = deepClone(snapshot.jointState);
    snapshot.basePositionMm = deepClone(snapshot.rootPose.positionMm);
    snapshot.apparatus = Object.values(snapshot.objects).map((item) => ({
      ...item,
      currentZone: item.currentFrame || "",
      heldBy: item.attachedTo || "",
      insertedInto: item.state?.insertedInto || "",
      operationState: {},
      transferState: item.state?.transferState || "unchanged",
      removed: false
    }));
    snapshot.grade = gradeScenario(this.definition, snapshot);
    return snapshot;
  }

  log(method, args, response) {
    this.state.commandLog.push({
      index: this.state.commandLog.length + 1,
      method,
      args: deepClone(args),
      ok: response.ok,
      code: response.code,
      message: response.message
    });
    const plantFault = this.plant?.fault || this.state.plant?.fault;
    this.state.feedback = plantFault
      ? { tone: "error", code: plantFault.code, message: plantFault.message, details: deepClone(plantFault) }
      : { tone: response.ok ? "ready" : "error", code: response.code, message: response.message };
    return { ...response, state: this.snapshot() };
  }

  frame(frameId) {
    const frame = this.definition.frames[frameId];
    if (!frame) throw new Error(`Unknown discoverable frame: ${frameId}. Call lab.frames() to inspect available frames.`);
    return frame;
  }

  async call(method, args = {}) {
    const generationAtStart = this.stateGeneration;
    const isResetCall = method === "robot.reset";
    try {
      const portableClient = ["so101_follower", "lekiwi_sim", "openarm_v2_bimanual"].includes(this.model.id);
      const semanticManipulation = ["skills.transport", "robot.grasp", "robot.release"].includes(method);
      if (!(portableClient && semanticManipulation && this.options.allowValidationSemanticCompilation !== true)) {
        assertApiMethod(method, this.definition.api.level);
      }
      let response;
      if (portableClient && semanticManipulation && this.options.allowValidationSemanticCompilation !== true) {
        response = failure(
          "PHYSICAL_SEND_ACTION_REQUIRED",
          `${method} cannot change portable browser state. Use the official robot client's send_action method so the fixed-step plant can verify live approach, opposing-finger contact, closure, carry, placement, opening, and release.`
        );
      }
      else if (method === "lab.frames") response = success("FRAMES", "Named task frames returned.", { frames: deepClone(this.definition.frames) });
      else if (method === "lab.observe") response = success("OBSERVATION", "Observable task state returned.", { observation: this.observableState() });
      else if (method === "lab.record_evidence") response = this.recordEvidence(args);
      else if (method === "robot.command_model") response = this.commandModel();
      else if (method === "robot.get_observation") response = this.getObservation();
      else if (method === "robot.send_action") response = await this.sendAction(args);
      else if (method === "robot.joint_state") response = success("JOINT_STATE", "Current executed joint sample returned.", { jointState: deepClone(this.state.jointState) });
      else if (method === "robot.plan_to_frame") response = await this.planToFrame(args.frameId, args);
      else if (method === "robot.execute") response = await this.executePlan(args.planId, args);
      else if (method === "robot.grasp") response = await this.grasp(args);
      else if (method === "robot.release") response = await this.release(args);
      else if (method === "robot.navigate") response = await this.navigate(args);
      else if (method === "robot.dock") response = await this.dock(args);
      else if (method === "robot.replan") response = await this.replan(args);
      else if (method === "robot.pause") {
        this.plant?.pause();
        response = success("PAUSED", "Simulation clock, fixed-step plant, compatible sleeps, and trajectory execution paused at the live actual state.", { executor: this.executor.pause() });
      }
      else if (method === "robot.resume") {
        this.plant?.resume();
        response = success("RESUMED", "Simulation clock, fixed-step plant, compatible sleeps, and trajectory execution resumed.", { executor: this.executor.resume() });
      }
      else if (method === "robot.stop") response = this.stop(args.reason);
      else if (method === "robot.reset") response = this.reset();
      else if (method === "compat.catalog") response = success("COMPATIBILITY_PROFILE", "Versioned portable Python compatibility profile returned.", { publicResult: compatibilityProfile(this.model.id) });
      else if (method === "compat.connect") response = this.compatConnect(args);
      else if (method === "compat.disconnect") response = this.compatDisconnect(args);
      else if (method === "compat.send_action") response = this.compatSendAction(args);
      else if (method === "compat.get_observation") response = this.compatGetObservation(args);
      else if (method === "compat.clock.now") response = success("SIMULATION_CLOCK", "Current simulation monotonic time returned.", { publicResult: this.plant?.clockNow?.() ?? 0 });
      else if (method === "compat.clock.sleep") response = await this.compatSleep(args);
      else if (method === "compat.hardware_unsupported") response = failure("HARDWARE_ONLY", `${args.name || "This operation"} is hardware-only; the browser uses a preloaded simulated calibration and provides no device setup.`);
      else if (method === "compat.ros.create") response = this.compatRosCreate(args);
      else if (method === "compat.ros.publish") response = this.compatRosPublish(args);
      else if (method === "compat.ros.joint_states") response = this.compatRosJointStates();
      else if (method === "compat.ros.goal") response = this.compatRosGoal(args);
      else if (method === "skills.transport") response = await this.transport(args);
      else if (method === "skills.fixture_operation") response = await this.fixtureOperation(args);
      else if (method === "challenge.solve_ik") response = this.solveIk(args);
      else if (method === "challenge.plan_waypoints") response = await this.planWaypoints(args);
      else if (method === "challenge.execute_waypoints") response = await this.executeWaypoints(args);
      else response = failure("API_UNIMPLEMENTED", `${method} is not implemented.`);
      if (!isResetCall && generationAtStart !== this.stateGeneration) {
        return {
          ...failure("STALE_CALL", `${method} completed after robot.reset replaced its execution state; the stale result was ignored.`),
          state: this.snapshot()
        };
      }
      return this.log(method, args, response);
    } catch (error) {
      if (!isResetCall && generationAtStart !== this.stateGeneration) {
        return {
          ...failure("STALE_CALL", `${method} failed after robot.reset replaced its execution state; the stale result was ignored.`),
          state: this.snapshot()
        };
      }
      return this.log(method, args, failure("API_ERROR", error.message));
    }
  }

  observableState() {
    return deepClone({
      frames: Object.fromEntries(Object.entries(this.definition.frames).map(([id, frame]) => [id, { positionMm: frame.positionMm, role: frame.role, tolerance: frame.tolerance }])),
      jointState: this.state.jointState,
      rootPose: this.state.rootPose,
      objects: this.state.objects,
      processes: this.state.processes,
      lastReachedFrame: this.state.lastReachedFrame,
      evidence: this.state.evidence
    });
  }

  compatConnect(args = {}) {
    if (!this.plant) return failure("UNSUPPORTED_ROBOT", `${this.model.id} has no portable Python compatibility profile.`);
    try {
      const publicResult = this.plant.connect(args.instanceId, args.config || {});
      return success("CONNECTED", "Connected to the preloaded browser digital model; no physical transport was opened.", { publicResult });
    } catch (error) {
      return failure(error.code || "CONNECT_FAILED", error.message, error.details || {});
    }
  }

  compatDisconnect(args = {}) {
    try {
      const publicResult = this.plant.disconnect(args.instanceId);
      return success("DISCONNECTED", "Disconnected from the browser compatibility instance.", { publicResult });
    } catch (error) {
      return failure(error.code || "DISCONNECT_FAILED", error.message, error.details || {});
    }
  }

  compatSendAction(args = {}) {
    try {
      const publicResult = this.plant.sendAction(args.instanceId, args.action, args.options || {});
      return success("TARGET_UPDATED", "Validated command target updated immediately; live actual state continues on the fixed-step plant.", { publicResult });
    } catch (error) {
      return failure(error.code || "ACTION_REJECTED", error.message, error.details || {});
    }
  }

  compatGetObservation(args = {}) {
    try {
      const publicResult = this.plant.getObservation(args.instanceId);
      return success("LIVE_OBSERVATION", "Live actual plant observation returned.", { publicResult });
    } catch (error) {
      return failure(error.code || "OBSERVATION_FAILED", error.message, error.details || {});
    }
  }

  async compatSleep(args = {}) {
    try {
      const publicResult = await this.plant.sleep(args.seconds);
      return success("SLEEP_COMPLETE", "Simulation-clock sleep completed.", { publicResult });
    } catch (error) {
      return failure(error.code || "SLEEP_FAILED", error.message, error.details || {});
    }
  }

  ensureRosPlantConnection() {
    if (this.model.id !== "openarm_v2_bimanual") throw Object.assign(new Error("The OpenArm ROS 2 source-pattern compatibility profile is available only for OpenArm."), { code: "ROS_PROFILE_UNAVAILABLE" });
    const instanceId = "ros2-source-pattern";
    if (!this.plant.connected.has(instanceId)) this.plant.connect(instanceId, { kind: "bimanual", side: "bimanual", cameras: {} });
    return instanceId;
  }

  compatRosCreate(args = {}) {
    try {
      this.ensureRosPlantConnection();
      const profile = compatibilityProfile(this.model.id).ros2SourcePatternProfile;
      const kind = String(args.kind || "");
      const name = String(args.name || "");
      const messageType = String(args.messageType || "");
      const allowed = kind === "subscription"
        ? name === "/joint_states" && messageType === "JointState"
        : kind === "publisher"
          ? profile.topics.includes(name) && name !== "/joint_states" && ["Float64MultiArray", "JointTrajectory"].includes(messageType)
          : kind === "action"
            ? profile.actions.includes(name) && messageType === "FollowJointTrajectory"
            : false;
      if (!allowed) return failure("ROS_FACILITY_UNSUPPORTED", `Unsupported ${kind || "ROS facility"} ${name || "(unnamed)"} with ${messageType || "unknown message type"}. Only the documented OpenArm 0.9.2/Humble source-pattern subset is accepted.`);
      return success("ROS_ENDPOINT_CREATED", `${kind} ${name} accepted by the OpenArm ROS 2 source-pattern compatibility profile.`, { publicResult: null });
    } catch (error) {
      return failure(error.code || "ROS_PROFILE_UNAVAILABLE", error.message);
    }
  }

  rosRoute(name) {
    if (name.includes("left_")) return { side: "left", prefix: "left_" };
    if (name.includes("right_")) return { side: "right", prefix: "right_" };
    return { side: "left", prefix: "left_" };
  }

  rosExpectedJoints(name, gripper = false) {
    const { side } = this.rosRoute(name);
    if (gripper) return [`openarm_${name.includes("left_") || name.includes("right_") ? `${side}_` : ""}finger_joint1`];
    return Array.from({ length: 7 }, (_, index) => `openarm_${name.includes("left_") || name.includes("right_") ? `${side}_` : ""}joint${index + 1}`);
  }

  rosActionFromRadians(name, positions, gripper = false) {
    const { prefix } = this.rosRoute(name);
    if (gripper) {
      const openingMetres = Number(positions[0]);
      if (!Number.isFinite(openingMetres) || openingMetres < 0 || openingMetres > 0.044) throw Object.assign(new Error("OpenArm finger position must be within the source-defined 0..0.044 metre range."), { code: "ROS_POSITION_LIMIT" });
      return { [`${prefix}gripper.pos`]: -65 * (1 - openingMetres / 0.044) };
    }
    return Object.fromEntries(positions.map((value, index) => [`${prefix}joint_${index + 1}.pos`, Number(value) * 180 / Math.PI]));
  }

  compatRosPublish(args = {}) {
    try {
      const instanceId = this.ensureRosPlantConnection();
      const topic = String(args.topic || "");
      const message = args.message || {};
      const gripper = topic.includes("gripper_controller");
      const expected = this.rosExpectedJoints(topic, gripper);
      let positions;
      if (message.type === "Float64MultiArray") positions = message.data;
      else if (message.type === "JointTrajectory") {
        if (JSON.stringify(message.jointNames) !== JSON.stringify(expected)) throw Object.assign(new Error(`JointTrajectory requires the complete exact joint list: ${expected.join(", ")}.`), { code: "ROS_JOINT_LIST" });
        this.validateRosPoints(message.points, expected.length);
        positions = message.points.at(-1).positions;
      } else throw Object.assign(new Error(`Unsupported published message type ${message.type || "unknown"}.`), { code: "ROS_MESSAGE_UNSUPPORTED" });
      if (!Array.isArray(positions) || positions.length !== expected.length) throw Object.assign(new Error(`${topic} requires exactly ${expected.length} position values in radians.`), { code: "ROS_JOINT_LIST" });
      const publicResult = this.plant.sendAction(instanceId, this.rosActionFromRadians(topic, positions, gripper));
      return success("ROS_COMMAND_ACCEPTED", "OpenArm source-pattern command target accepted in radians.", { publicResult });
    } catch (error) {
      return failure(error.code || "ROS_COMMAND_REJECTED", error.message);
    }
  }

  validateRosPoints(points, jointCount) {
    if (!Array.isArray(points) || !points.length) throw Object.assign(new Error("FollowJointTrajectory requires at least one point."), { code: "ROS_TRAJECTORY_EMPTY" });
    let previous = -Infinity;
    points.forEach((point, index) => {
      const time = Number(point.timeFromStart);
      if (!Array.isArray(point.positions) || point.positions.length !== jointCount) throw Object.assign(new Error(`Trajectory point ${index + 1} requires ${jointCount} positions.`), { code: "ROS_JOINT_LIST" });
      if (!Number.isFinite(time) || time < 0 || time <= previous) throw Object.assign(new Error("time_from_start values must be finite, non-negative, and strictly monotonic."), { code: "ROS_TIME_ORDER" });
      if (!point.positions.every((value) => Number.isFinite(Number(value)))) throw Object.assign(new Error(`Trajectory point ${index + 1} contains a non-finite position.`), { code: "ROS_POSITION_VALUE" });
      previous = time;
    });
    return previous;
  }

  compatRosGoal(args = {}) {
    try {
      const instanceId = this.ensureRosPlantConnection();
      const actionName = String(args.action || "");
      const profile = compatibilityProfile(this.model.id).ros2SourcePatternProfile;
      if (!profile.actions.includes(actionName)) return failure("ROS_ACTION_UNSUPPORTED", `Unsupported action ${actionName}.`);
      const trajectory = args.trajectory || {};
      const gripper = actionName.includes("gripper_controller");
      const expected = this.rosExpectedJoints(actionName, gripper);
      if (JSON.stringify(trajectory.jointNames) !== JSON.stringify(expected)) return success("ROS_GOAL_REJECTED", `Goal rejected: complete exact joint list required (${expected.join(", ")}).`, { publicResult: { accepted: false, errorCode: -2, errorString: "INVALID_JOINTS", duration: 0 } });
      const duration = this.validateRosPoints(trajectory.points, expected.length);
      const target = trajectory.points.at(-1).positions;
      this.plant.sendAction(instanceId, this.rosActionFromRadians(actionName, target, gripper));
      this.state.eventLog.push({ type: "ROS_GOAL_ACCEPTED", action: actionName, duration, simulationClockSeconds: this.plant.clockNow() });
      return success("ROS_GOAL_ACCEPTED", "FollowJointTrajectory goal accepted by the source-pattern profile.", { publicResult: { accepted: true, errorCode: 0, errorString: "", duration } });
    } catch (error) {
      return failure(error.code || "ROS_GOAL_REJECTED", error.message);
    }
  }

  compatRosJointStates() {
    try {
      const instanceId = this.ensureRosPlantConnection();
      const observation = this.plant.getObservation(instanceId);
      const names = [...Array.from({ length: 7 }, (_, index) => `openarm_left_joint${index + 1}`), "openarm_left_finger_joint1", ...Array.from({ length: 7 }, (_, index) => `openarm_right_joint${index + 1}`), "openarm_right_finger_joint1"];
      const position = [
        ...Array.from({ length: 7 }, (_, index) => Number(observation[`left_joint_${index + 1}.pos`]) * Math.PI / 180),
        0.044 * (1 + Number(observation["left_gripper.pos"]) / 65),
        ...Array.from({ length: 7 }, (_, index) => Number(observation[`right_joint_${index + 1}.pos`]) * Math.PI / 180),
        0.044 * (1 + Number(observation["right_gripper.pos"]) / 65),
      ];
      return success("ROS_JOINT_STATES", "Live authoritative plant state returned as source-pattern JointState radians.", { publicResult: { name: names, position } });
    } catch (error) {
      return failure(error.code || "ROS_JOINT_STATES_FAILED", error.message);
    }
  }

  commandModel() {
    if (this.model.id !== "so101_follower") return failure("MORPHOLOGY_LIMIT", "This source-traceable joint command model is specific to the SO-101 follower.");
    return success("COMMAND_MODEL", "SO-101 LeRobot command/observation mapping returned with simulation boundaries.", { commandModel: deepClone(SO101_COMMAND_MODEL) });
  }

  getObservation() {
    if (this.model.id !== "so101_follower") return failure("MORPHOLOGY_LIMIT", "get_observation correspondence is currently modeled only for the SO-101 follower.");
    return success("POSITION_OBSERVATION", "Current simulated SO-101 position observation returned.", {
      observation: so101JointStateToAction(this.state.jointState),
      calibrationStatus: this.state.calibrationStatus,
      physicalCalibrationConfirmed: false,
      runState: this.state.runState
    });
  }

  async sendAction(args = {}) {
    if (this.model.id !== "so101_follower") return failure("MORPHOLOGY_LIMIT", "send_action correspondence is currently modeled only for the SO-101 follower.");
    const checked = validateSo101Action(args.action);
    if (!checked.ok) return failure(checked.code, checked.message, checked);
    const durationMs = Number(args.durationMs ?? 480);
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 5000) {
      return failure("INVALID_INTERPOLATION", "durationMs must be a finite simulation-only value from 0 through 5000 ms.");
    }
    const target = { ...this.state.jointState, ...so101ActionToJointState(checked.action) };
    const sampleCount = Math.max(1, Math.min(60, Number(args.sampleCount ?? Math.max(1, Math.ceil(durationMs / 80))) || 1));
    const path = interpolateJointStates(this.state.jointState, target, sampleCount);
    const obstacles = frameObstacles(this.definition, "", { includeContactSurfaces: true });
    for (let index = 0; index < path.length; index += 1) {
      const report = stateCollisionReport(this.model, path[index], obstacles, { basePose: this.state.rootPose });
      if (!report.ok) return failure("ACTION_COLLISION", "The simulation rejected this straight joint-target interpolation because a structural fixture collision was detected.", {
        sampleIndex: index,
        collision: report.collisions[0],
        simulationGuardrail: true,
        physicalApiBehavior: "LeRobot send_action does not establish collision avoidance."
      });
    }
    const trajectory = {
      schema: "robobuddy.trajectory.v2",
      kind: "so101-joint-action",
      samples: path.map((jointState) => ({ jointState, phase: "joint_action" }))
    };
    this.executor.load(trajectory);
    this.state.runState = "running";
    const intervalMs = durationMs <= 0 ? 0 : durationMs / sampleCount;
    const executed = await this.executor.run({ intervalMs });
    this.state.runState = executed.status === "complete" ? "ready" : executed.status;
    if (executed.status !== "complete") return failure("STOPPED", "SO-101 joint action stopped at the last executed sample.", { executor: executed });
    this.state.lastAction = deepClone(checked.action);
    this.state.lastReachedFrame = "joint_action";
    const targetSummary = SO101_COMMAND_MODEL.fields
      .filter(({ actionKey }) => Object.hasOwn(checked.action, actionKey))
      .map(({ actionKey }) => `${actionKey}=${Number(checked.action[actionKey]).toFixed(1)}`)
      .join(", ");
    return success("ACTION_SENT", `Accepted SO-101 joint target executed in awaited order using simulation-only linear interpolation. Target ${targetSummary}.`, {
      action: deepClone(checked.action),
      observation: so101JointStateToAction(this.state.jointState),
      executor: executed,
      simulationInterpolation: true,
      physicalTimingValidated: false,
      physicalRelativeTargetClippingModeled: false
    });
  }

  solveIk(args) {
    const frame = args.frameId ? this.frame(args.frameId) : { positionMm: args.positionMm, chainId: args.chainId };
    const ik = inverseKinematics(this.model, frame.positionMm, {
      chainId: args.chainId || frame.chainId || Object.keys(this.model.chains)[0],
      initialJointState: args.initialJointState || this.state.jointState,
      seed: args.seed,
      starts: args.starts,
      toleranceMm: frame.tolerance?.positionMm || args.toleranceMm,
      basePose: this.state.rootPose,
      directionConstraint: args.directionConstraint || frame.directionConstraint,
    });
    return ik.ok ? success("IK_SOLVED", "Deterministic multi-start IK found a joint-limited solution.", { ik }) : failure(ik.code, "Target is unreachable within the configured canonical model and limits.", { ik });
  }

  async planToFrame(frameId, args = {}) {
    const frame = this.frame(frameId);
    if (this.model.rootMotion === "constrained-waypoint") return this.planG1Waypoint(frameId, args);
    if (frame.basePositionMm && this.model.rootMotion === "planar") {
      const navigation = this.planBasePath(frame.basePositionMm, args);
      if (!navigation.ok) return navigation;
    }
    const startJointState = args.initialJointState || this.state.jointState;
    const planned = this.planFrame(frameId, startJointState, args, { ikSeed: 17, pathSeed: 41 });
    if (!planned.ok) return failure(planned.causeCode, planned.message, planned);
    const { chainId, ik, path } = planned;
    const planId = `plan-${++this.planCounter}`;
    this.plans.set(planId, { id: planId, kind: "joint", frameId, chainId, path: path.path, planner: path.code });
    return success("PLAN_READY", `Collision-checked plan ready for ${frameId}.`, { planId, planner: path.code, sampleCount: path.path.length, ikSeedIndex: ik.seedIndex });
  }

  planFrame(frameId, startJointState, args = {}, defaults = {}) {
    const frame = this.frame(frameId);
    const targetMm = Array.isArray(args.targetMm) ? args.targetMm : frame.positionMm;
    const chainId = args.chainId || frame.chainId || Object.keys(this.model.chains)[0];
    const chainJointIds = this.model.chains[chainId].joints.flatMap((joint) => joint.jointId ? [joint.jointId] : []);
    const obstacles = frameObstacles(this.definition, args.departureFixtureId || frame.contactFixtureId);
    const explicitStarts = args.starts === undefined || args.starts === null ? null : Math.max(2, Number(args.starts));
    const baseIkSeed = Number(args.seed ?? defaults.ikSeed ?? 17);
    const basePathSeed = Number(args.pathSeed ?? args.seed ?? defaults.pathSeed ?? 31);
    const attempts = [];
    for (let index = 0; index < FRAME_PLAN_ATTEMPTS.length; index += 1) {
      const retry = FRAME_PLAN_ATTEMPTS[index];
      const jointProfile = this.model.id === "openarm_v2_bimanual" ? retry.openArmProfile : "full";
      const activeJoints = activeJointsForAttempt(this.model, chainJointIds, jointProfile);
      const starts = index === 0
        ? (explicitStarts ?? 10)
        : Math.max(explicitStarts ?? 0, retry.minimumStarts);
      let finalBlockingPair = null;
      const ik = inverseKinematics(this.model, targetMm, {
        chainId,
        initialJointState: startJointState,
        seed: baseIkSeed + retry.offset,
        starts,
        activeJoints,
        toleranceMm: frame.tolerance?.positionMm || 3,
        endOffsetMm: args.endOffsetMm,
        basePose: this.state.rootPose,
        directionConstraint: args.directionConstraint || frame.directionConstraint,
        // Nearby task frames should produce nearby robot configurations. This
        // continuity score prevents a lower-residual but remote IK branch from
        // making the arm visibly swing or "dance" between simple waypoints.
        scoreJointState: (candidateState) => Math.hypot(...chainJointIds.map((jointId) => {
          const delta = Number(candidateState[jointId] ?? startJointState[jointId] ?? 0)
            - Number(startJointState[jointId] ?? 0);
          // Position-only IK has redundant wrist solutions. Prefer the nearby
          // wrist/base branch so a short Cartesian move does not introduce a
          // gratuitous roll, flip, or shared-base swing.
          const weight = this.model.id === "openarm_v2_bimanual"
            ? (jointId === "base_yaw" ? 6 : /_j[57]$/.test(jointId) ? 3 : /_j6$/.test(jointId) ? 1.25 : 1)
            : 1;
          return delta * weight;
        })),
        acceptJointState: (candidateState) => {
          // Candidate states contain the active chain only. Collision reporting
          // must retain the complete segment-start pose of the inactive chain.
          const fullState = { ...startJointState, ...candidateState };
          const report = stateCollisionReport(this.model, fullState, obstacles, { basePose: this.state.rootPose });
          if (!report.ok) finalBlockingPair = report.failure || report.collisions?.[0] || null;
          if (!report.ok) return false;
          if (typeof args.acceptJointState === "function" && !args.acceptJointState(fullState)) {
            finalBlockingPair = { geometry: args.acceptJointStateGeometry || "configured-state-constraint" };
            return false;
          }
          return true;
        }
      });
      const attempt = { index, seed: baseIkSeed + retry.offset, pathSeed: basePathSeed + retry.offset, starts, jointProfile, activeJoints, maxIterations: retry.maxIterations ?? Number(args.maxIterations ?? 1600), ikCode: ik.code, ikDiagnostics: ik.diagnostics };
      if (!ik.ok) {
        attempts.push({ ...attempt, finalBlockingPair });
        continue;
      }
      const path = planJointPath(this.model, startJointState, ik.jointState, obstacles, {
        chainId,
        seed: attempt.pathSeed,
        maxIterations: attempt.maxIterations,
        maxStepDeg: args.maxStepDeg ?? (this.model.id === "openarm_v2_bimanual" ? 2 : 4),
        collisionStepDeg: args.collisionStepDeg,
        allowRrt: this.model.id !== "openarm_v2_bimanual" || jointProfile === "full",
        basePose: this.state.rootPose,
        fixedJointState: startJointState,
        acceptState: (state) => {
          const fullState = { ...startJointState, ...state };
          const directionOk = args.directionConstraintAtTargetOnly === true || directionConstraintSatisfied(
            this.model,
            fullState,
            chainId,
            this.state.rootPose,
            args.directionConstraint || frame.directionConstraint
          );
          return directionOk && (typeof args.acceptJointState !== "function" || args.acceptJointState(fullState));
        },
        constraintFailureCode: args.constraintFailureCode || "PAYLOAD_UPRIGHT_CONSTRAINT",
      });
      attempts.push({ ...attempt, pathCode: path.code, directFailure: path.directFailure || null });
      if (path.ok) return { ok: true, frameId, chainId, ik, path, attempts };
    }
    const last = attempts.at(-1) || {};
    const allBlocked = attempts.length > 0 && attempts.every((attempt) => attempt.ikCode === "IK_GOAL_BLOCKED");
    const causeCode = last.pathCode || (allBlocked ? "IK_GOAL_BLOCKED" : (last.ikCode || "IK_UNREACHABLE"));
    return {
      ok: false,
      causeCode,
      phase: args.phase || "planning",
      frame: frameId,
      attempts,
      finalBlockingPair: last.finalBlockingPair || null,
      directFailure: last.directFailure || null,
      message: causeCode === "IK_UNREACHABLE"
        ? `${frameId} is unreachable within the canonical joint limits.`
        : `No accepted collision-free plan was found to ${frameId} (${causeCode}).`
    };
  }

  planBasePath(goalPositionMm, args = {}) {
    const grid = this.definition.navigation?.occupancyGrid;
    if (!grid) return failure("GRID_UNAVAILABLE", "This scenario has no configured occupancy grid.");
    const stow = requireStowedForDrive(this.model, this.state.jointState);
    if (!stow.ok) return failure(stow.code, "Stow the LeKiwi arm before driving.", { violations: stow.violations });
    const start = [this.state.rootPose.positionMm[0], this.state.rootPose.positionMm[2]];
    const goal = [goalPositionMm[0], goalPositionMm[2]];
    const planned = planOccupancyGridAStar(grid, start, goal, args);
    return planned.ok ? success("BASE_PATH_READY", "Occupancy-grid A* path ready.", { path: planned }) : failure(planned.code, "No occupancy-grid route is available.", { path: planned });
  }

  async navigate(args) {
    if (this.model.rootMotion === "fixed") return failure("FIXED_ROOT", "This robot has a fixed root and cannot navigate.");
    if (this.model.rootMotion === "constrained-waypoint") return this.executeG1Waypoint(args.frameId, args);
    const frame = this.frame(args.frameId);
    const planned = this.planBasePath(frame.basePositionMm || frame.positionMm, args);
    if (!planned.ok) return planned;
    const samples = planned.path.pathMm.map(([x, z]) => ({ rootPose: { positionMm: [x, 0, z], headingDeg: this.state.rootPose.headingDeg }, phase: "base_transfer" }));
    const planId = `plan-${++this.planCounter}`;
    this.plans.set(planId, { id: planId, kind: "base", frameId: args.frameId, samples, planner: "A_STAR" });
    return this.executePlan(planId, args);
  }

  planG1Waypoint(frameId) {
    const graph = this.definition.navigation?.waypointGraph;
    if (!graph) return failure("WAYPOINT_GRAPH_UNAVAILABLE", "G1 tasks require a constrained waypoint graph.");
    const start = this.state.lastReachedFrame;
    const queue = [[start]];
    const visited = new Set([start]);
    while (queue.length) {
      const path = queue.shift();
      const node = path.at(-1);
      if (node === frameId) {
        const planId = `plan-${++this.planCounter}`;
        this.plans.set(planId, { id: planId, kind: "g1-waypoint", frameId, path });
        return success("PLAN_READY", `Constrained G1 waypoint route ready for ${frameId}.`, { planId, waypoints: path });
      }
      (graph.edges?.[node] || []).slice().sort().forEach((next) => { if (!visited.has(next)) { visited.add(next); queue.push([...path, next]); } });
    }
    return failure("NO_WAYPOINT_ROUTE", `No constrained waypoint route reaches ${frameId}.`);
  }

  async executeG1Waypoint(frameId, args = {}) {
    const planned = this.planG1Waypoint(frameId);
    if (!planned.ok) return planned;
    return this.executePlan(planned.planId, args);
  }

  async executePlan(planId, args = {}) {
    const plan = this.plans.get(planId);
    if (!plan) return failure("UNKNOWN_PLAN", `Unknown or stale plan: ${planId}.`);
    let samples;
    if (plan.kind === "joint") samples = appendEventsToFinal(plan.path, args.events || [], "joint_motion");
    else if (plan.kind === "base") samples = plan.samples;
    else if (plan.kind === "g1-waypoint") {
      samples = [];
      let startPose = deepClone(this.state.rootPose);
      const currentlyCarrying = Object.values(this.state.objects).some((object) => object.attachedTo === "secured_carrier_mount");
      const attachingAtDestination = (args.events || []).some((event) => event.type === "ATTACH_OBJECT");
      plan.path.slice(1).forEach((frameId) => {
        const frame = this.frame(frameId);
        const targetPosition = [...frame.positionMm];
        const targetHeading = Number(frame.headingDeg || 0);
        const dx = targetPosition[0] - startPose.positionMm[0];
        const dz = targetPosition[2] - startPose.positionMm[2];
        const rawHeadingDelta = ((targetHeading - startPose.headingDeg + 540) % 360) - 180;
        const walking = Math.hypot(dx, dz) > 1;
        const turning = Math.abs(rawHeadingDelta) > 1;
        // Root interpolation is paired with a fixed, authored joint cycle so the
        // robot never appears to slide in a static pose. This remains a waypoint
        // visualization, not leg IK, balance, foot-contact, or dynamics output.
        const stepCount = Math.max(4, Math.min(18, Math.ceil(Math.hypot(dx, dz) / 75)));
        for (let step = 1; step <= stepCount; step += 1) {
          const progress = step / stepCount;
          const finalSample = step === stepCount;
          const carrying = currentlyCarrying || (attachingAtDestination && finalSample);
          samples.push({
            rootPose: {
              positionMm: [
                startPose.positionMm[0] + dx * progress,
                startPose.positionMm[1] + (targetPosition[1] - startPose.positionMm[1]) * progress,
                startPose.positionMm[2] + dz * progress
              ],
              headingDeg: finalSample ? targetHeading : startPose.headingDeg + rawHeadingDelta * progress
            },
            jointState: finalSample
              ? { ...G1_NEUTRAL_LEGS, ...(carrying ? G1_CARRY_ARMS : G1_NEUTRAL_ARMS) }
              : g1LogisticsPose({ walking, turning, leftLead: (samples.length + step) % 2 === 0, carrying, turnDirection: rawHeadingDelta }),
            reachedFrame: finalSample ? frameId : undefined,
            phase: "waypoint_logistics_kinematic_cycle"
          });
        }
        startPose = { positionMm: targetPosition, headingDeg: targetHeading };
      });
      if (samples.length && args.events?.length) samples.at(-1).events = deepClone(args.events);
    }
    const trajectory = { schema: "robobuddy.trajectory.v2", kind: plan.kind, samples: samples || [] };
    this.executor.load(trajectory);
    this.state.runState = "running";
    const configuredIntervalMs = Number(args.intervalMs ?? this.options.intervalMs ?? 0);
    const intervalMs = plan.kind === "g1-waypoint" && configuredIntervalMs > 0 ? Math.max(80, configuredIntervalMs) : configuredIntervalMs;
    const executed = await this.executor.run({ intervalMs });
    this.state.runState = executed.status === "complete" ? "ready" : executed.status;
    if (executed.status === "stopped") return failure("STOPPED", "Trajectory stopped at the last executed sample.", { executor: executed });
    this.state.lastReachedFrame = plan.frameId;
    if (!this.state.visitedFrames.includes(plan.frameId)) this.state.visitedFrames.push(plan.frameId);
    this.plans.delete(planId);
    return success("TRAJECTORY_COMPLETE", `Executed ${plan.frameId} trajectory.`, { executor: executed, frameId: plan.frameId });
  }

  async applyTrajectorySample(sample, index) {
    if (sample.rootPose) {
      const changed = JSON.stringify(sample.rootPose.positionMm) !== JSON.stringify(this.state.rootPose.positionMm);
      if (changed && this.model.rootMotion === "fixed") {
        this.state.fixedRootViolation = true;
        this.executor.stop("fixed-root invariant");
        throw new Error("Fixed robot root motion was rejected.");
      }
      this.state.rootPose = deepClone(sample.rootPose);
    }
    if (sample.jointState) this.state.jointState = { ...this.state.jointState, ...deepClone(sample.jointState) };
    if (sample.reachedFrame) {
      this.state.lastReachedFrame = sample.reachedFrame;
      if (!this.state.visitedFrames.includes(sample.reachedFrame)) this.state.visitedFrames.push(sample.reachedFrame);
    }
    if (sample.compiledAction) {
      const targetSummary = Object.entries(sample.compiledAction.action).map(([key, value]) => `${key}=${Number(value).toFixed(1)}`).join(", ");
      this.state.lastAction = deepClone(sample.compiledAction.action);
      this.state.commandLog.push({
        index: this.state.commandLog.length + 1,
        method: sample.compiledAction.method,
        args: {
          action: deepClone(sample.compiledAction.action),
          compiledFrom: "skills.transport",
          phase: sample.compiledAction.phase
        },
        ok: true,
        code: "SIMULATION_COMPILED_TARGET",
        message: `${sample.compiledAction.phase}: ${sample.compiledAction.explanation}. Target ${targetSummary}.`
      });
    }
    await this.options.onSample?.(deepClone(sample), index, this.snapshot());
  }

  applyEvent(event, context = {}) {
    const entry = { sequence: this.state.eventLog.length + 1, ...deepClone(event) };
    if (entry.type === "ATTACH_OBJECT") {
      const priorContact = this.state.eventLog.findLast((item) => item.type === "CONTACT" && item.objectId === entry.objectId);
      if (!priorContact) throw new Error(`Object ${entry.objectId} cannot attach before contact.`);
      const object = this.state.objects[entry.objectId];
      if (!object) throw new Error(`Unknown object ${entry.objectId}.`);
      object.attachedTo = entry.effector;
      object.attachmentInterface = entry.attachmentInterface || "gripper";
      object.currentFrame = "";
    }
    if (entry.type === "DETACH_OBJECT") {
      const object = this.state.objects[entry.objectId];
      if (!object?.attachedTo) throw new Error(`Object ${entry.objectId} is not attached.`);
      object.attachedTo = "";
      object.attachmentInterface = "";
      object.currentFrame = entry.frameId;
    }
    if (entry.type === "PROCESS_COMMIT") {
      const priorContact = this.state.eventLog.findLast((item) => item.type === "PROCESS_CONTACT" && item.processId === entry.processId);
      if (!priorContact) throw new Error(`Process ${entry.processId} cannot commit before contact.`);
      const process = this.state.processes[entry.processId];
      if (!process) throw new Error(`Unknown process ${entry.processId}.`);
      const definition = this.definition.processModels.find((item) => item.id === entry.processId);
      const missing = (definition?.prerequisites || []).filter((predicate) => !gradeScenario({
        goalPredicates: [predicate],
        prohibitedStates: [],
        evidenceRequirements: []
      }, this.state).goals[0].passed);
      if (missing.length) throw new Error(`Process ${entry.processId} prerequisites are not satisfied.`);
      process.state = entry.value;
      process.commits += 1;
      process.objectId = priorContact.objectId || process.objectId || "";
      process.fixtureId = priorContact.fixtureId || process.fixtureId || definition?.fixtureId || "";
    }
    this.state.eventLog.push(entry);
    this.options.onEvent?.(deepClone(entry), context, this.snapshot());
  }

  async planSegment(frameId, startJointState, args = {}) {
    const planned = this.planFrame(frameId, startJointState, args, { ikSeed: 101, pathSeed: 43 });
    if (!planned.ok || !args.departureFixtureId) return planned;
    const obstacles = frameObstacles(this.definition, "", { includeContactSurfaces: true });
    let clearedDeparture = false;
    for (let index = 0; index < planned.path.path.length; index += 1) {
      const report = stateCollisionReport(this.model, planned.path.path[index], obstacles, { basePose: this.state.rootPose });
      const departureCollisions = report.collisions.filter((item) => item.obstacleId.startsWith(`${args.departureFixtureId}:`));
      const unrelatedCollisions = report.collisions.filter((item) => !item.obstacleId.startsWith(`${args.departureFixtureId}:`));
      if (unrelatedCollisions.length || (clearedDeparture && departureCollisions.length)) {
        return {
          ok: false,
          causeCode: "CONTACT_DEPARTURE_COLLISION",
          phase: args.phase || frameId,
          frame: frameId,
          finalBlockingPair: unrelatedCollisions[0] || departureCollisions[0],
          message: `The path from ${args.departureFixtureId} did not clear once and remain clear of structural fixtures.`
        };
      }
      if (!departureCollisions.length) clearedDeparture = true;
    }
    if (!clearedDeparture) {
      return {
        ok: false,
        causeCode: "CONTACT_NOT_CLEARED",
        phase: args.phase || frameId,
        frame: frameId,
        message: `The path never cleared intentional contact with ${args.departureFixtureId}.`
      };
    }
    return planned;
  }

  resolvePlaceFrame(args) {
    if (args.placeFrame) {
      if (!this.definition.frames[args.placeFrame]) return failure("UNKNOWN_PLACE_FRAME", `Unknown placement frame ${args.placeFrame}.`);
      return success("PLACE_FRAME_RESOLVED", `Using explicit placement frame ${args.placeFrame}.`, { frameId: args.placeFrame });
    }
    const destination = this.frame(args.destinationFrame);
    const chainId = args.chainId || destination.chainId || Object.keys(this.model.chains)[0];
    const matches = Object.entries(this.definition.frames).filter(([, frame]) => (
      frame.coincidentWith === args.destinationFrame && frame.role === "contact" && (frame.chainId || "default") === chainId
    ));
    if (matches.length > 1) return failure("AMBIGUOUS_PLACE_FRAME", `Multiple contact frames coincide with ${args.destinationFrame}: ${matches.map(([id]) => id).join(", ")}.`, { matches: matches.map(([id]) => id) });
    return success("PLACE_FRAME_RESOLVED", "Placement frame resolved deterministically.", { frameId: matches[0]?.[0] || args.destinationFrame });
  }

  async transport(args) {
    if (this.model.id === "unitree_g1_29dof") return this.g1Transport(args);
    if (this.model.id === "so101_follower") return this.so101Transport(args);
    const required = ["objectId", "approachFrame", "contactFrame", "liftFrame", "destinationFrame", "retreatFrame"];
    const missing = required.filter((key) => !args[key]);
    if (missing.length) return failure("INVALID_TRANSPORT", `Transport requires ${missing.join(", ")}.`);
    const object = this.state.objects[args.objectId];
    if (!object) return failure("UNKNOWN_OBJECT", `Unknown object ${args.objectId}.`);
    const effector = args.effector || (this.model.id === "openarm_v2_bimanual" ? "left" : "default");
    const graspCheck = this.validateConfiguredGrasp(object, {
      effector,
      approachFrame: args.approachFrame,
      contactFrame: args.contactFrame,
      liftFrame: args.liftFrame
    });
    if (!graspCheck.ok) return graspCheck;
    const placeResolution = this.resolvePlaceFrame(args);
    if (!placeResolution.ok) return placeResolution;
    const placeFrame = placeResolution.frameId;
    if (args.processId) {
      const process = this.definition.processModels.find((item) => item.id === args.processId);
      if (!process) return failure("UNKNOWN_PROCESS", `Unknown process ${args.processId}.`);
      const projected = deepClone(this.state);
      projected.objects[args.objectId].attachedTo = "";
      projected.objects[args.objectId].attachmentInterface = "";
      projected.objects[args.objectId].currentFrame = args.destinationFrame;
      projected.visitedFrames = [...new Set([
        ...(projected.visitedFrames || []),
        args.approachFrame,
        args.contactFrame,
        args.liftFrame,
        args.destinationFrame,
        placeFrame,
        args.retreatFrame
      ])];
      projected.eventLog.push(
        { type: "PLACE_CONTACT", objectId: args.objectId, frameId: placeFrame },
        { type: "DETACH_OBJECT", objectId: args.objectId, frameId: args.destinationFrame }
      );
      const missing = process.prerequisites.filter((predicate) => !evaluatePredicate(projected, predicate));
      if (missing.length) {
        return failure("PROCESS_PREREQUISITE", `${args.processId} prerequisites would not be satisfied at placement: ${missing.map(describePredicate).join("; ")}.`, missingDetails(missing));
      }
    }
    let cursor = { ...this.state.jointState };
    const segment = async (frameId, seedOffset, segmentOptions = {}) => {
      const baseSeed = Number(args.seed ?? 101) + seedOffset;
      const planned = await this.planSegment(frameId, cursor, { ...args, ...segmentOptions, seed: baseSeed, phase: frameId });
      if (!planned.ok) throw Object.assign(new Error(planned.message), { planning: planned });
      cursor = { ...cursor, ...planned.path.path.at(-1) };
      return planned.path.path;
    };
    try {
      const approach = await segment(args.approachFrame, 0);
      const contact = await segment(args.contactFrame, 1);
      // Only definitions that explicitly declare the physical-rest contract
      // receive an upright payload constraint. Applying it to legacy Arduino
      // tasks makes their reviewed reference frames unreachable.
      const payloadDirection = object.physicalRest
        ? uprightPayloadConstraint(this.model, cursor, effector, this.state.rootPose, 2)
        : null;
      const lift = await segment(args.liftFrame, 2, payloadDirection ? { directionConstraint: payloadDirection } : {});
      const transfer = await segment(args.destinationFrame, 3, payloadDirection ? { directionConstraint: payloadDirection } : {});
      const placeTarget = this.frame(placeFrame);
      const destinationTarget = this.frame(args.destinationFrame);
      const samePhysicalTarget = placeFrame === args.destinationFrame
        || (
          (placeTarget.chainId || "default") === (destinationTarget.chainId || "default")
          && distance3(placeTarget.positionMm, destinationTarget.positionMm) <= Math.max(
            Number(placeTarget.tolerance?.positionMm || 0),
            Number(destinationTarget.tolerance?.positionMm || 0),
            0.001
          )
        );
      const place = samePhysicalTarget ? [cursor] : await segment(placeFrame, 4, payloadDirection ? { directionConstraint: payloadDirection } : {});
      const retreatClearance = this.model.id === "lekiwi_sim"
        ? await segment(args.destinationFrame, 5)
        : [];
      const exteriorRetreat = this.model.id === "lekiwi_sim" && this.definition.frames.delivery_clearance
        ? await segment("delivery_clearance", 6)
        : [];
      const retreat = await segment(args.retreatFrame, 7);
      const placeEvents = [
        { type: "PLACE_CONTACT", objectId: args.objectId, frameId: placeFrame },
        { type: "DETACH_OBJECT", objectId: args.objectId, frameId: args.destinationFrame }
      ];
      if (args.processId) placeEvents.push(
        { type: "PROCESS_CONTACT", processId: args.processId, objectId: args.objectId, fixtureId: this.definition.processModels.find((item) => item.id === args.processId)?.fixtureId || "" },
        { type: "PROCESS_COMMIT", processId: args.processId, value: args.processValue || "complete" }
      );
      const trajectory = buildContactSequence([
        { phase: "pre_contact", samples: appendEventsToFinal(approach, [], "pre_contact") },
        { phase: "contact", samples: appendEventsToFinal(contact, [{ type: "CONTACT", objectId: args.objectId, frameId: args.contactFrame }, { type: "ATTACH_OBJECT", objectId: args.objectId, effector, attachmentInterface: "gripper" }], "contact") },
        { phase: "lift", samples: appendEventsToFinal(lift, [], "lift") },
        { phase: "transfer", samples: appendEventsToFinal(transfer, [], "transfer") },
        { phase: "place", samples: appendEventsToFinal(place, placeEvents, "place") },
        { phase: "retreat", samples: appendEventsToFinal([...retreatClearance, ...exteriorRetreat, ...retreat], [], "retreat") }
      ]);
      this.executor.load(trajectory);
      this.state.runState = "running";
      const executed = await this.executor.run({ intervalMs: Number(args.intervalMs ?? this.options.intervalMs ?? 0) });
      this.state.runState = executed.status === "complete" ? "ready" : executed.status;
      if (executed.status !== "complete") return failure("STOPPED", "Transport stopped at the last executed sample.", { executor: executed });
      [args.approachFrame, args.contactFrame, args.liftFrame, args.destinationFrame, placeFrame, args.retreatFrame].forEach((id) => { if (!this.state.visitedFrames.includes(id)) this.state.visitedFrames.push(id); });
      this.state.lastReachedFrame = args.retreatFrame;
      return success("TRANSPORT_COMPLETE", `${args.objectId} was contact-gated and placed at ${args.destinationFrame}.`, { executor: executed });
    } catch (error) {
      return failure("TRANSPORT_PLAN_FAILED", error.message, error.planning || {});
    }
  }

  async so101Transport(args) {
    const required = ["objectId", "approachFrame", "contactFrame", "liftFrame", "destinationFrame", "retreatFrame"];
    const missing = required.filter((key) => !args[key]);
    if (missing.length) return failure("INVALID_TRANSPORT", `Transport requires ${missing.join(", ")}.`);
    const object = this.state.objects[args.objectId];
    if (!object) return failure("UNKNOWN_OBJECT", `Unknown object ${args.objectId}.`);
    const effector = args.effector || "default";
    const graspCheck = this.validateConfiguredGrasp(object, {
      effector,
      approachFrame: args.approachFrame,
      contactFrame: args.contactFrame,
      liftFrame: args.liftFrame
    });
    if (!graspCheck.ok) return graspCheck;
    const placeResolution = this.resolvePlaceFrame(args);
    if (!placeResolution.ok) return placeResolution;
    const placeFrame = placeResolution.frameId;
    if (args.processId) {
      const process = this.definition.processModels.find((item) => item.id === args.processId);
      if (!process) return failure("UNKNOWN_PROCESS", `Unknown process ${args.processId}.`);
      const projected = deepClone(this.state);
      projected.objects[args.objectId].attachedTo = "";
      projected.objects[args.objectId].attachmentInterface = "";
      projected.objects[args.objectId].currentFrame = args.destinationFrame;
      projected.visitedFrames = [...new Set([...(projected.visitedFrames || []), args.approachFrame, args.contactFrame, args.liftFrame, args.destinationFrame, placeFrame, args.retreatFrame])];
      projected.eventLog.push(
        { type: "PLACE_CONTACT", objectId: args.objectId, frameId: placeFrame },
        { type: "DETACH_OBJECT", objectId: args.objectId, frameId: args.destinationFrame }
      );
      const missingPrerequisites = process.prerequisites.filter((predicate) => !evaluatePredicate(projected, predicate));
      if (missingPrerequisites.length) {
        return failure("PROCESS_PREREQUISITE", `${args.processId} prerequisites would not be satisfied at placement: ${missingPrerequisites.map(describePredicate).join("; ")}.`, missingDetails(missingPrerequisites));
      }
    }

    const openValue = SO101_COMMAND_MODEL.gripper.openValue;
    const graspValue = SO101_COMMAND_MODEL.gripper.graspValue;
    let cursor = { ...this.state.jointState, gripper: openValue };
    const segment = async (frameId, seedOffset, segmentOptions = {}) => {
      const baseSeed = Number(args.seed ?? 101) + seedOffset;
      const planned = await this.planSegment(frameId, cursor, { ...args, ...segmentOptions, seed: baseSeed, phase: frameId });
      if (!planned.ok) throw Object.assign(new Error(planned.message), { planning: planned });
      cursor = { ...cursor, ...planned.path.path.at(-1) };
      return planned.path.path.map((jointState) => ({ ...cursor, ...jointState }));
    };

    try {
      const openJaw = interpolateJointStates(this.state.jointState, cursor, 5);
      const approach = await segment(args.approachFrame, 0, { directionConstraintAtTargetOnly: true });
      const contact = await segment(args.contactFrame, 1);
      const payloadDirection = uprightPayloadConstraint(this.model, cursor, "default", this.state.rootPose, 2);
      const contactCursor = { ...cursor };
      const contactObjectPose = initialObjectPose(object);
      const contactTool = forwardKinematics(this.model, contactCursor, { chainId: "default", basePose: this.state.rootPose }).transform;
      const plannedAttachmentTransform = contactObjectPose
        ? composeTransform(inverseTransform(contactTool), { position: contactObjectPose.positionMm, rotation: contactObjectPose.rotationMatrix })
        : null;
      const payloadObjectCollisionFree = (jointState) => {
        if (!plannedAttachmentTransform) return false;
        const tool = forwardKinematics(this.model, jointState, { chainId: "default", basePose: this.state.rootPose }).transform;
        const payloadPose = composeTransform(tool, plannedAttachmentTransform);
        const payloadProxy = physicalObjectProxy(object, payloadPose);
        if (!payloadProxy) return false;
        return Object.values(this.state.objects).filter((other) => other.id !== object.id && !other.attachedTo).every((other) => {
          const declaredPose = other.physicalRest?.poses?.[other.currentFrame];
          const otherProxy = declaredPose
            ? physicalObjectProxy(other, { position: declaredPose.positionMm, rotation: declaredPose.rotationMatrix })
            : physicalObjectProxy(other);
          return !otherProxy || !proxiesCollide(payloadProxy, otherProxy);
        });
      };
      const payloadCollisionOptions = {
        acceptJointState: payloadObjectCollisionFree,
        acceptJointStateGeometry: "payload-object-oriented-box",
        constraintFailureCode: "PAYLOAD_OBJECT_COLLISION",
        collisionStepDeg: 0.2,
      };
      cursor = { ...cursor, gripper: graspValue };
      const closeJaw = interpolateJointStates(contactCursor, cursor, 5);
      const lift = await segment(args.liftFrame, 2, { ...payloadCollisionOptions, departureFixtureId: `${args.objectId}_pickup_adapter` });
      // Keep the carrier above the complete 88 mm payload envelope while it
      // crosses between the fixed pickup and receiving work surfaces.  The
      // placement descent is a separate, upright-constrained segment.
      const transfer = await segment(args.destinationFrame, 3, payloadCollisionOptions);
      const placeTarget = this.frame(placeFrame);
      const destinationTarget = this.frame(args.destinationFrame);
      const samePhysicalTarget = placeFrame === args.destinationFrame
        || (
          (placeTarget.chainId || "default") === (destinationTarget.chainId || "default")
          && distance3(placeTarget.positionMm, destinationTarget.positionMm) <= Math.max(
            Number(placeTarget.tolerance?.positionMm || 0),
            Number(destinationTarget.tolerance?.positionMm || 0),
            0.001
          )
        );
      const place = samePhysicalTarget ? [{ ...cursor }] : await segment(placeFrame, 4, {
        ...payloadCollisionOptions,
        directionConstraint: payloadDirection,
        directionConstraintAtTargetOnly: true,
      });
      const placeCursor = { ...cursor };
      cursor = { ...cursor, gripper: openValue };
      const openRelease = interpolateJointStates(placeCursor, cursor, 5);
      // Keep the open gripper upright for a short, locally constrained
      // separation before allowing the distant retreat target to choose a new
      // redundant wrist branch. Exact jaw/apparatus surface contact may slide
      // tangentially during this move, but the plant still caps penetration at
      // the configured 1 mm contact tolerance.
      const releaseClearance = await segment(placeFrame, 5, {
        targetMm: [placeTarget.positionMm[0], placeTarget.positionMm[1] + 40, placeTarget.positionMm[2]],
        departureFixtureId: `${args.objectId}_destination_slot`,
        directionConstraint: payloadDirection,
      });
      const retreat = await segment(args.retreatFrame, 6);

      const openJawSamples = tagCompiledAction(appendEventsToFinal(openJaw, [], "pre_contact"), "open_for_approach", "configured gripper opening before clearance motion");
      const approachSamples = tagCompiledAction(markReachedFrame(appendEventsToFinal(approach, [], "pre_contact"), args.approachFrame), "approach", `IK convenience resolved ${args.approachFrame} to this joint target`);
      const contactSamples = tagCompiledAction(markReachedFrame(appendEventsToFinal(contact, [
        { type: "CONTACT", objectId: args.objectId, frameId: args.contactFrame }
      ], "contact"), args.contactFrame), "contact", `controlled contact target for ${args.contactFrame}`);
      const closeSamples = tagCompiledAction(appendEventsToFinal(closeJaw, [
        { type: "ATTACH_OBJECT", objectId: args.objectId, effector, attachmentInterface: "gripper" }
      ], "contact"), "close_after_contact", "configured gripper closing; attachment occurs only after the close sample");
      const liftSamples = tagCompiledAction(markReachedFrame(appendEventsToFinal(lift, [], "lift"), args.liftFrame), "lift", `short clearance lift target ${args.liftFrame}`);
      const transferSamples = tagCompiledAction(markReachedFrame(appendEventsToFinal(transfer, [], "transfer"), args.destinationFrame), "transfer", `short transfer target for semantic destination ${args.destinationFrame}`);
      const placeSamples = tagCompiledAction(markReachedFrame(appendEventsToFinal(place, [
        { type: "PLACE_CONTACT", objectId: args.objectId, frameId: placeFrame }
      ], "place"), placeFrame), "place_contact", `physical placement-contact target ${placeFrame}`);
      const releaseEvents = [
        { type: "DETACH_OBJECT", objectId: args.objectId, frameId: args.destinationFrame }
      ];
      if (args.processId) releaseEvents.push(
        { type: "PROCESS_CONTACT", processId: args.processId, objectId: args.objectId, fixtureId: this.definition.processModels.find((item) => item.id === args.processId)?.fixtureId || "" },
        { type: "PROCESS_COMMIT", processId: args.processId, value: args.processValue || "complete" }
      );
      const releaseSamples = tagCompiledAction(appendEventsToFinal(openRelease, releaseEvents, "place"), "open_then_detach", "configured gripper opening; detachment preserves the placement world pose after the open sample");
      const releaseClearanceSamples = tagCompiledAction(appendEventsToFinal(releaseClearance, [], "retreat"), "release_clearance", "40 mm upright open-jaw separation before the arm changes retreat orientation");
      const retreatSamples = tagCompiledAction(markReachedFrame(appendEventsToFinal(retreat, [], "retreat"), args.retreatFrame), "retreat", `clear retreat target ${args.retreatFrame}`);

      const trajectory = buildContactSequence([
        { phase: "pre_contact", samples: [...openJawSamples, ...approachSamples] },
        { phase: "contact", samples: [...contactSamples, ...closeSamples] },
        { phase: "lift", samples: liftSamples },
        { phase: "transfer", samples: transferSamples },
        { phase: "place", samples: [...placeSamples, ...releaseSamples] },
        { phase: "retreat", samples: [...releaseClearanceSamples, ...retreatSamples] }
      ]);
      this.executor.load(trajectory);
      this.state.runState = "running";
      const executed = await this.executor.run({ intervalMs: Number(args.intervalMs ?? this.options.intervalMs ?? 0) });
      this.state.runState = executed.status === "complete" ? "ready" : executed.status;
      if (executed.status !== "complete") return failure("STOPPED", "Transport stopped at the last executed sample.", { executor: executed });
      this.state.lastReachedFrame = args.retreatFrame;
      return success("TRANSPORT_COMPLETE", `${args.objectId} was contact-gated, visibly gripped, and placed at ${args.destinationFrame}.`, {
        executor: executed,
        compiledTo: "robot.send_action",
        simulationConvenience: true,
        physicalIkOrPlanningClaim: false
      });
    } catch (error) {
      return failure("TRANSPORT_PLAN_FAILED", error.message, error.planning || {});
    }
  }

  async g1Transport(args) {
    const required = ["objectId", "approachFrame", "contactFrame", "liftFrame", "destinationFrame", "retreatFrame"];
    const missing = required.filter((key) => !args[key]);
    if (missing.length) return failure("INVALID_TRANSPORT", `Secured-carrier transport requires ${missing.join(", ")}.`);
    const object = this.state.objects[args.objectId];
    if (
      !object?.securedCarrier
      || object.configuredAttachmentInterface !== this.model.configured.carrierInterface
      || object.state?.contentsSecured !== true
    ) {
      return failure("MORPHOLOGY_LIMIT", "G1 can transport only mechanically compatible secured carriers.");
    }
    if (object.attachedTo) return failure("ALREADY_ATTACHED", `${args.objectId} is already attached.`);
    if (object.currentFrame !== args.contactFrame) {
      return failure("OBJECT_NOT_AT_CONTACT", `${args.objectId} is at ${object.currentFrame || "an unknown frame"}, not ${args.contactFrame}.`);
    }
    const approachFrame = args.approachFrame;
    const pickupFrame = args.contactFrame;
    const clearanceFrame = args.liftFrame;
    const destinationFrame = args.destinationFrame;
    const retreatFrame = args.retreatFrame;
    for (const frameId of [approachFrame, pickupFrame, clearanceFrame, destinationFrame, retreatFrame]) this.frame(frameId);
    const executeWaypoint = async (frameId, events = []) => {
      const planned = this.planG1Waypoint(frameId);
      if (!planned.ok) return planned;
      return this.executePlan(planned.planId, { events, intervalMs: args.intervalMs });
    };
    let response = await executeWaypoint(approachFrame);
    if (!response.ok) return response;
    response = await executeWaypoint(pickupFrame, [
      { type: "CONTACT", objectId: args.objectId, frameId: pickupFrame },
      { type: "DOCK_CONTACT", objectId: args.objectId, frameId: pickupFrame },
      { type: "LATCH_ENGAGED", objectId: args.objectId, frameId: pickupFrame },
      { type: "ATTACH_OBJECT", objectId: args.objectId, effector: "secured_carrier_mount", attachmentInterface: this.model.configured.carrierInterface }
    ]);
    if (!response.ok) return response;
    response = await executeWaypoint(clearanceFrame);
    if (!response.ok) return response;
    response = await executeWaypoint(destinationFrame, [
      { type: "DOCK_CONTACT", objectId: args.objectId, frameId: destinationFrame },
      { type: "DETACH_OBJECT", objectId: args.objectId, frameId: destinationFrame }
    ]);
    if (!response.ok) return response;
    response = await executeWaypoint(retreatFrame);
    return response.ok ? success("LOGISTICS_COMPLETE", `${args.objectId} delivered by constrained docking and latch sequence.`) : response;
  }

  async dock(args) {
    if (this.model.id !== "unitree_g1_29dof") return failure("MORPHOLOGY_LIMIT", "Docking is reserved for secured-carrier G1 logistics.");
    return this.g1Transport(args);
  }

  async grasp(args) {
    const object = this.state.objects[args.objectId];
    if (!object) return failure("UNKNOWN_OBJECT", `Unknown object ${args.objectId}.`);
    if (this.model.id === "unitree_g1_29dof") return failure("MORPHOLOGY_LIMIT", "G1 has no free-grasping API; use secured-carrier docking.");
    const contactFrame = args.contactFrame || this.state.lastReachedFrame;
    const frame = this.frame(contactFrame);
    if (frame.role !== "contact") return failure("CONTACT_REQUIRED", "Grasp requires a named contact frame.");
    if (this.state.lastReachedFrame !== contactFrame) return failure("FRAME_NOT_REACHED", `Move to ${contactFrame} before grasping.`);
    const effector = args.effector || (this.model.id === "openarm_v2_bimanual" ? "left" : "default");
    const graspCheck = this.validateConfiguredGrasp(object, { effector, contactFrame });
    if (!graspCheck.ok) return graspCheck;
    this.applyEvent({ type: "CONTACT", objectId: args.objectId, frameId: contactFrame });
    this.applyEvent({ type: "ATTACH_OBJECT", objectId: args.objectId, effector, attachmentInterface: "gripper" });
    return success("GRASPED", `${args.objectId} attached after contact.`);
  }

  validateConfiguredGrasp(object, args) {
    if (object.attachedTo) return failure("ALREADY_ATTACHED", `${object.id} is already attached.`);
    if (object.currentFrame !== args.contactFrame) {
      return failure("OBJECT_NOT_AT_CONTACT", `${object.id} is at ${object.currentFrame || "an unknown frame"}, not ${args.contactFrame}.`);
    }
    const compatibleEffectors = object.compatibleEffectors || object.allowedEffectors || [];
    if (compatibleEffectors.length && !compatibleEffectors.includes(args.effector)) {
      return failure("EFFECTOR_INCOMPATIBLE", `${args.effector} is not configured for ${object.id}.`);
    }
    const configured = this.definition.grasps.filter((grasp) => grasp.objectId === object.id);
    const matches = configured.some((grasp) => (
      grasp.effector === args.effector
      && grasp.contactFrame === args.contactFrame
      && (!args.approachFrame || !grasp.approachFrame || grasp.approachFrame === args.approachFrame)
      && (!args.liftFrame || !grasp.liftFrame || grasp.liftFrame === args.liftFrame)
    ));
    return matches
      ? success("GRASP_CONFIGURATION_VALID", "Configured object, effector, and contact frames agree.")
      : failure("GRASP_CONFIGURATION_MISMATCH", `No configured grasp matches ${object.id} at ${args.contactFrame} with ${args.effector}.`);
  }

  async release(args) {
    const object = this.state.objects[args.objectId];
    if (!object?.attachedTo) return failure("NOT_ATTACHED", `${args.objectId} is not attached.`);
    const frame = this.frame(args.frameId || this.state.lastReachedFrame);
    if (!new Set(["destination", "contact", "latch", "dock"]).has(frame.role)) return failure("PLACE_CONTACT_REQUIRED", "Release requires a named placement/contact frame.");
    if (this.state.lastReachedFrame !== (args.frameId || this.state.lastReachedFrame)) {
      return failure("FRAME_NOT_REACHED", `Move to ${args.frameId} before releasing.`);
    }
    this.applyEvent({ type: "PLACE_CONTACT", objectId: args.objectId, frameId: args.frameId || this.state.lastReachedFrame });
    this.applyEvent({ type: "DETACH_OBJECT", objectId: args.objectId, frameId: args.frameId || this.state.lastReachedFrame });
    return success("RELEASED", `${args.objectId} released at ${args.frameId || this.state.lastReachedFrame}.`);
  }

  async fixtureOperation(args) {
    const process = this.definition.processModels.find((item) => item.id === args.processId);
    if (!process) return failure("UNKNOWN_PROCESS", `Unknown process ${args.processId}.`);
    const object = args.objectId ? this.state.objects[args.objectId] : null;
    if (args.objectId && !object) return failure("UNKNOWN_OBJECT", `Unknown object ${args.objectId}.`);
    const fixture = args.fixtureId ? this.definition.fixtures.find((item) => item.id === args.fixtureId) : null;
    if (args.fixtureId && !fixture) return failure("UNKNOWN_FIXTURE", `Unknown fixture ${args.fixtureId}.`);
    if (process.fixtureId && process.fixtureId !== args.fixtureId) {
      return failure("PROCESS_FIXTURE_MISMATCH", `${args.processId} is configured for ${process.fixtureId}, not ${args.fixtureId || "an unspecified fixture"}.`);
    }
    if (fixture && fixture.visible !== true) return failure("FIXTURE_NOT_VISIBLE", `${args.fixtureId} is not a visible process fixture.`);
    const missing = process.prerequisites.filter((predicate) => !gradeScenario({ goalPredicates: [predicate], prohibitedStates: [], evidenceRequirements: [] }, this.state).goals[0].passed);
    if (missing.length) return failure("PROCESS_PREREQUISITE", `${args.processId} prerequisites are not satisfied: ${missing.map(describePredicate).join("; ")}.`, missingDetails(missing));
    this.applyEvent({ type: "PROCESS_CONTACT", processId: args.processId, objectId: args.objectId, fixtureId: args.fixtureId });
    this.applyEvent({ type: "PROCESS_COMMIT", processId: args.processId, value: args.value || process.completeState || "complete" });
    return success("PROCESS_COMPLETE", `${args.processId} committed at its contact event.`);
  }

  recordEvidence(args) {
    const requirement = this.definition.evidenceRequirements.find((item) => item.id === args.requirementId);
    if (!requirement) return failure("UNKNOWN_EVIDENCE", `Unknown evidence requirement ${args.requirementId}.`);
    if (!String(args.value ?? "").trim()) return failure("EMPTY_EVIDENCE", "Evidence must be non-empty.");
    const entry = { requirementId: args.requirementId, value: String(args.value), source: "learner-recorded", eventSequence: this.state.eventLog.length };
    if (!evaluateEvidenceRequirement(this.state, requirement, entry)) {
      return failure("EVIDENCE_NOT_AVAILABLE", "The evidence value or its observable event/predicate prerequisite is not satisfied.");
    }
    this.state.evidence.push(entry);
    return success("EVIDENCE_RECORDED", `${args.requirementId} recorded.`);
  }

  async replan(args) {
    return this.planToFrame(args.frameId, { ...args, seed: Number(args.seed ?? 0) + 1009, pathSeed: Number(args.pathSeed ?? 0) + 2027 });
  }

  async planWaypoints(args) {
    const planIds = [];
    for (const frameId of args.frameIds || []) {
      const response = await this.planToFrame(frameId, { ...args, initialJointState: args.initialJointState || this.state.jointState });
      if (!response.ok) return response;
      planIds.push(response.planId);
    }
    return success("WAYPOINTS_PLANNED", "Explicit discoverable waypoints planned.", { planIds });
  }

  async executeWaypoints(args) {
    for (const planId of args.planIds || []) {
      const response = await this.executePlan(planId, args);
      if (!response.ok) return response;
    }
    return success("WAYPOINTS_COMPLETE", "Explicit waypoint sequence completed.");
  }

  stop(reason = "user") {
    const executor = this.executor.stop(reason || "user");
    this.plant?.stop(reason || "user");
    this.state.runState = "stopped";
    this.state.eventLog.push({ sequence: this.state.eventLog.length + 1, type: "STOPPED", reason: reason || "user", sampleIndex: executor.index });
    return success("STOPPED", "Execution stopped at the last executed joint sample; contact state was not fabricated.", { executor });
  }

  reset() {
    this.stateGeneration += 1;
    this.state = deepClone(this.baseline);
    this.plans.clear();
    this.executor.reset();
    this.createPortablePlant();
    return success("RESET", "Fresh v2 task state restored; drafts and legacy v1 data were not reinterpreted.");
  }

  dispose() {
    this.plant?.dispose?.();
  }

  async executeProgram(calls = []) {
    const results = [];
    for (const call of calls) {
      const response = await this.call(call.method, call.args || {});
      results.push(response);
      if (!response.ok) break;
    }
    return { ok: results.every((item) => item.ok), results, grade: gradeScenario(this.definition, this.state), state: this.snapshot() };
  }
}
