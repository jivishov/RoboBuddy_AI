import { assertApiMethod } from "./api-contract.js";
import { evaluateEvidenceRequirement, gradeScenario } from "./grading.js";
import { inverseKinematics } from "./kinematics.js";
import { deepClone } from "./math.js";
import { planJointPath, planOccupancyGridAStar, requireStowedForDrive } from "./planner.js";
import { homeJointState, loadRobotModel } from "./robot-model-catalog.js";
import { assertScenarioV2 } from "./scenario-schema.js";
import { buildContactSequence, TrajectoryExecutor } from "./trajectory-executor.js";

function result(ok, code, message, extra = {}) { return { ok, code, message, ...extra }; }
function failure(code, message, extra = {}) { return result(false, code, message, extra); }
function success(code, message, extra = {}) { return result(true, code, message, extra); }

function objectMap(definition) {
  return Object.fromEntries(definition.objects.map((item) => [item.id, {
    ...deepClone(item),
    currentFrame: item.initialFrame,
    attachedTo: "",
    attachmentInterface: "",
    state: deepClone(item.initialState || {})
  }]));
}

function processMap(definition) {
  return Object.fromEntries(definition.processModels.map((item) => [item.id, { id: item.id, state: item.initialState || "ready", commits: 0 }]));
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
    fixedRootViolation: false,
    feedback: { tone: "ready", code: "READY", message: "Scenario v2 is ready." }
  };
}

function frameObstacles(definition, excludedFixtureId = "") {
  return definition.fixtures.flatMap((fixture) => {
    if (fixture.id === excludedFixtureId || !fixture.collisionProxy) return [];
    return [{ id: fixture.id, ...deepClone(fixture.collisionProxy) }];
  });
}

function appendEventsToFinal(path, events = [], phase = "motion") {
  const samples = path.map((jointState) => ({ jointState: deepClone(jointState), phase }));
  if (!samples.length) return [];
  samples.at(-1).events = deepClone(events);
  return samples;
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
    this.baseline = deepClone(this.state);
    this.plans = new Map();
    this.planCounter = 0;
    this.executor = new TrajectoryExecutor({
      baseline: { jointState: this.state.jointState, rootPose: this.state.rootPose },
      sleep: options.sleep,
      onSample: async (sample, index) => this.applyTrajectorySample(sample, index),
      onEvent: async (event, sample, index) => this.applyEvent(event, { sample, index })
    });
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
    this.state.feedback = { tone: response.ok ? "ready" : "error", code: response.code, message: response.message };
    return { ...response, state: this.snapshot() };
  }

  frame(frameId) {
    const frame = this.definition.frames[frameId];
    if (!frame) throw new Error(`Unknown discoverable frame: ${frameId}. Call lab.frames() to inspect available frames.`);
    return frame;
  }

  async call(method, args = {}) {
    try {
      assertApiMethod(method, this.definition.api.level);
      let response;
      if (method === "lab.frames") response = success("FRAMES", "Named task frames returned.", { frames: deepClone(this.definition.frames) });
      else if (method === "lab.observe") response = success("OBSERVATION", "Observable task state returned.", { observation: this.observableState() });
      else if (method === "lab.record_evidence") response = this.recordEvidence(args);
      else if (method === "robot.joint_state") response = success("JOINT_STATE", "Current executed joint sample returned.", { jointState: deepClone(this.state.jointState) });
      else if (method === "robot.plan_to_frame") response = await this.planToFrame(args.frameId, args);
      else if (method === "robot.execute") response = await this.executePlan(args.planId, args);
      else if (method === "robot.grasp") response = await this.grasp(args);
      else if (method === "robot.release") response = await this.release(args);
      else if (method === "robot.navigate") response = await this.navigate(args);
      else if (method === "robot.dock") response = await this.dock(args);
      else if (method === "robot.replan") response = await this.replan(args);
      else if (method === "robot.pause") response = success("PAUSED", "Trajectory execution paused at the last executed sample.", { executor: this.executor.pause() });
      else if (method === "robot.resume") response = success("RESUMED", "Trajectory execution resumed.", { executor: this.executor.resume() });
      else if (method === "robot.stop") response = this.stop(args.reason);
      else if (method === "robot.reset") response = this.reset();
      else if (method === "skills.transport") response = await this.transport(args);
      else if (method === "skills.fixture_operation") response = await this.fixtureOperation(args);
      else if (method === "challenge.solve_ik") response = this.solveIk(args);
      else if (method === "challenge.plan_waypoints") response = await this.planWaypoints(args);
      else if (method === "challenge.execute_waypoints") response = await this.executeWaypoints(args);
      else response = failure("API_UNIMPLEMENTED", `${method} is not implemented.`);
      return this.log(method, args, response);
    } catch (error) {
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

  solveIk(args) {
    const frame = args.frameId ? this.frame(args.frameId) : { positionMm: args.positionMm, chainId: args.chainId };
    const ik = inverseKinematics(this.model, frame.positionMm, {
      chainId: args.chainId || frame.chainId || Object.keys(this.model.chains)[0],
      initialJointState: args.initialJointState || this.state.jointState,
      seed: args.seed,
      starts: args.starts,
      toleranceMm: frame.tolerance?.positionMm || args.toleranceMm,
      basePose: this.state.rootPose
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
    const chainId = args.chainId || frame.chainId || Object.keys(this.model.chains)[0];
    const ik = inverseKinematics(this.model, frame.positionMm, {
      chainId,
      initialJointState: args.initialJointState || this.state.jointState,
      seed: args.seed,
      starts: args.starts || 10,
      toleranceMm: frame.tolerance?.positionMm || 3,
      basePose: this.state.rootPose
    });
    if (!ik.ok) return failure("IK_UNREACHABLE", `${frameId} is unreachable within the canonical joint limits.`, { ik });
    const path = planJointPath(this.model, this.state.jointState, ik.jointState, frameObstacles(this.definition, frame.contactFixtureId), {
      chainId,
      seed: args.pathSeed || args.seed || 41,
      maxIterations: args.maxIterations || 1600,
      basePose: this.state.rootPose
    });
    if (!path.ok) return failure(path.code, `No collision-free path was found to ${frameId}.`, { path });
    const planId = `plan-${++this.planCounter}`;
    this.plans.set(planId, { id: planId, kind: "joint", frameId, chainId, path: path.path, planner: path.code });
    return success("PLAN_READY", `Collision-checked plan ready for ${frameId}.`, { planId, planner: path.code, sampleCount: path.path.length, ikSeedIndex: ik.seedIndex });
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
      samples = plan.path.slice(1).map((frameId) => {
        const frame = this.frame(frameId);
        return { rootPose: { positionMm: [...frame.positionMm], headingDeg: Number(frame.headingDeg || 0) }, reachedFrame: frameId, phase: "waypoint_logistics" };
      });
      if (samples.length && args.events?.length) samples.at(-1).events = deepClone(args.events);
    }
    const trajectory = { schema: "robobuddy.trajectory.v2", kind: plan.kind, samples: samples || [] };
    this.executor.load(trajectory);
    this.state.runState = "running";
    const executed = await this.executor.run({ intervalMs: Number(args.intervalMs ?? this.options.intervalMs ?? 0) });
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
    }
    this.state.eventLog.push(entry);
    this.options.onEvent?.(deepClone(entry), context, this.snapshot());
  }

  async planSegment(frameId, startJointState, args = {}) {
    const frame = this.frame(frameId);
    const chainId = args.chainId || frame.chainId || Object.keys(this.model.chains)[0];
    const ik = inverseKinematics(this.model, frame.positionMm, {
      chainId,
      initialJointState: startJointState,
      seed: args.seed,
      starts: args.starts || 10,
      toleranceMm: frame.tolerance?.positionMm || 3,
      basePose: this.state.rootPose
    });
    if (!ik.ok) throw new Error(`${frameId} is unreachable (${ik.errorMm.toFixed(2)} mm residual).`);
    const planned = planJointPath(this.model, startJointState, ik.jointState, frameObstacles(this.definition, frame.contactFixtureId), { chainId, seed: args.pathSeed || args.seed || 43, basePose: this.state.rootPose });
    if (!planned.ok) throw new Error(`${frameId} has no collision-free path.`);
    return planned.path;
  }

  async transport(args) {
    if (this.model.id === "unitree_g1_29dof") return this.g1Transport(args);
    const required = ["objectId", "approachFrame", "contactFrame", "liftFrame", "destinationFrame", "retreatFrame"];
    const missing = required.filter((key) => !args[key]);
    if (missing.length) return failure("INVALID_TRANSPORT", `Transport requires ${missing.join(", ")}.`);
    const object = this.state.objects[args.objectId];
    if (!object) return failure("UNKNOWN_OBJECT", `Unknown object ${args.objectId}.`);
    const effector = args.effector || (this.model.id === "openarm_v2_bimanual" ? "left" : "default");
    let cursor = { ...this.state.jointState };
    const segment = async (frameId, seedOffset) => {
      const path = await this.planSegment(frameId, cursor, { ...args, seed: Number(args.seed || 101) + seedOffset });
      cursor = { ...path.at(-1) };
      return path;
    };
    try {
      const approach = await segment(args.approachFrame, 0);
      const contact = await segment(args.contactFrame, 1);
      const lift = await segment(args.liftFrame, 2);
      const transfer = await segment(args.destinationFrame, 3);
      const placeFrame = args.placeFrame || args.destinationFrame;
      const place = placeFrame === args.destinationFrame ? [cursor] : await segment(placeFrame, 4);
      const retreat = await segment(args.retreatFrame, 5);
      const placeEvents = [
        { type: "PLACE_CONTACT", objectId: args.objectId, frameId: placeFrame },
        { type: "DETACH_OBJECT", objectId: args.objectId, frameId: args.destinationFrame }
      ];
      if (args.processId) placeEvents.push(
        { type: "PROCESS_CONTACT", processId: args.processId, objectId: args.objectId },
        { type: "PROCESS_COMMIT", processId: args.processId, value: args.processValue || "complete" }
      );
      const trajectory = buildContactSequence([
        { phase: "pre_contact", samples: appendEventsToFinal(approach, [], "pre_contact") },
        { phase: "contact", samples: appendEventsToFinal(contact, [{ type: "CONTACT", objectId: args.objectId, frameId: args.contactFrame }, { type: "ATTACH_OBJECT", objectId: args.objectId, effector, attachmentInterface: "gripper" }], "contact") },
        { phase: "lift", samples: appendEventsToFinal(lift, [], "lift") },
        { phase: "transfer", samples: appendEventsToFinal(transfer, [], "transfer") },
        { phase: "place", samples: appendEventsToFinal(place, placeEvents, "place") },
        { phase: "retreat", samples: appendEventsToFinal(retreat, [], "retreat") }
      ]);
      this.executor.load(trajectory);
      this.state.runState = "running";
      const executed = await this.executor.run({ intervalMs: Number(args.intervalMs ?? this.options.intervalMs ?? 0) });
      this.state.runState = executed.status === "complete" ? "ready" : executed.status;
      if (executed.status !== "complete") return failure("STOPPED", "Transport stopped at the last executed sample.", { executor: executed });
      [args.approachFrame, args.contactFrame, args.liftFrame, args.destinationFrame, args.retreatFrame].forEach((id) => { if (!this.state.visitedFrames.includes(id)) this.state.visitedFrames.push(id); });
      this.state.lastReachedFrame = args.retreatFrame;
      return success("TRANSPORT_COMPLETE", `${args.objectId} was contact-gated and placed at ${args.destinationFrame}.`, { executor: executed });
    } catch (error) {
      return failure("TRANSPORT_PLAN_FAILED", error.message);
    }
  }

  async g1Transport(args) {
    const object = this.state.objects[args.objectId];
    if (!object?.securedCarrier || object.attachmentInterface !== this.model.configured.carrierInterface) {
      return failure("MORPHOLOGY_LIMIT", "G1 can transport only mechanically compatible secured carriers.");
    }
    const pickupFrame = args.contactFrame;
    const destinationFrame = args.destinationFrame;
    const retreatFrame = args.retreatFrame;
    for (const frameId of [pickupFrame, destinationFrame, retreatFrame]) this.frame(frameId);
    const pickup = this.planG1Waypoint(pickupFrame);
    if (!pickup.ok) return pickup;
    let response = await this.executePlan(pickup.planId, { events: [
      { type: "CONTACT", objectId: args.objectId, frameId: pickupFrame },
      { type: "DOCK_CONTACT", objectId: args.objectId, frameId: pickupFrame },
      { type: "ATTACH_OBJECT", objectId: args.objectId, effector: "secured_carrier_mount", attachmentInterface: this.model.configured.carrierInterface }
    ], intervalMs: args.intervalMs });
    if (!response.ok) return response;
    const delivery = this.planG1Waypoint(destinationFrame);
    if (!delivery.ok) return delivery;
    response = await this.executePlan(delivery.planId, { events: [
      { type: "DOCK_CONTACT", objectId: args.objectId, frameId: destinationFrame },
      { type: "DETACH_OBJECT", objectId: args.objectId, frameId: destinationFrame }
    ], intervalMs: args.intervalMs });
    if (!response.ok) return response;
    const retreat = this.planG1Waypoint(retreatFrame);
    if (!retreat.ok) return retreat;
    response = await this.executePlan(retreat.planId, { intervalMs: args.intervalMs });
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
    const frame = this.frame(args.contactFrame || this.state.lastReachedFrame);
    if (frame.role !== "contact") return failure("CONTACT_REQUIRED", "Grasp requires a named contact frame.");
    this.applyEvent({ type: "CONTACT", objectId: args.objectId, frameId: args.contactFrame || this.state.lastReachedFrame });
    this.applyEvent({ type: "ATTACH_OBJECT", objectId: args.objectId, effector: args.effector || "default", attachmentInterface: "gripper" });
    return success("GRASPED", `${args.objectId} attached after contact.`);
  }

  async release(args) {
    const object = this.state.objects[args.objectId];
    if (!object?.attachedTo) return failure("NOT_ATTACHED", `${args.objectId} is not attached.`);
    const frame = this.frame(args.frameId || this.state.lastReachedFrame);
    if (!new Set(["destination", "contact", "latch", "dock"]).has(frame.role)) return failure("PLACE_CONTACT_REQUIRED", "Release requires a named placement/contact frame.");
    this.applyEvent({ type: "PLACE_CONTACT", objectId: args.objectId, frameId: args.frameId || this.state.lastReachedFrame });
    this.applyEvent({ type: "DETACH_OBJECT", objectId: args.objectId, frameId: args.frameId || this.state.lastReachedFrame });
    return success("RELEASED", `${args.objectId} released at ${args.frameId || this.state.lastReachedFrame}.`);
  }

  async fixtureOperation(args) {
    const process = this.definition.processModels.find((item) => item.id === args.processId);
    if (!process) return failure("UNKNOWN_PROCESS", `Unknown process ${args.processId}.`);
    const missing = process.prerequisites.filter((predicate) => !gradeScenario({ goalPredicates: [predicate], prohibitedStates: [], evidenceRequirements: [] }, this.state).goals[0].passed);
    if (missing.length) return failure("PROCESS_PREREQUISITE", `${args.processId} prerequisites are not satisfied.`, { missing });
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
    return this.planToFrame(args.frameId, { ...args, seed: Number(args.seed || 0) + 1009, pathSeed: Number(args.pathSeed || 0) + 2027 });
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
    this.state.runState = "stopped";
    this.state.eventLog.push({ sequence: this.state.eventLog.length + 1, type: "STOPPED", reason: reason || "user", sampleIndex: executor.index });
    return success("STOPPED", "Execution stopped at the last executed joint sample; contact state was not fabricated.", { executor });
  }

  reset() {
    this.state = deepClone(this.baseline);
    this.plans.clear();
    this.executor.reset();
    return success("RESET", "Fresh v2 task state restored; drafts and legacy v1 data were not reinterpreted.");
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
