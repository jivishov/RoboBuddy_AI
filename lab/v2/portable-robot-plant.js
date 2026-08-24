import { gripperContactWitnesses, proxiesCollide, sampleContactGeometry, sampleRenderedGeometry, stateCollisionReport } from "./collision.js?v=20260823-physical-fidelity-5";
import { evaluatePredicate } from "./grading.js";
import { forwardKinematics } from "./kinematics.js?v=20260823-physical-fidelity-3";
import { composeTransform, deepClone, distance3, inverseTransform, transformPoint } from "./math.js?v=20260823-physical-fidelity-3";
import { compatibilityProfile } from "./python-compatibility-catalog.js";
import { objectWorldTransform, physicalObjectProxy, supportSurface, validateRestPose } from "./physical-rest.js?v=20260823-physical-fidelity-3";
import { radialSurfaceRadiusAtHeight } from "./apparatus-geometry.js?v=20260823-physical-fidelity-4";

export const PORTABLE_PLANT_SCHEMA = "robobuddy.portable-robot-plant.v1";
export const PORTABLE_PLANT_TICK_SECONDS = 0.02;

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw fail("INVALID_VALUE", `${label} must be a finite number.`);
  return number;
}

function fixtureObstacles(definition) {
  return (definition.fixtures || []).flatMap((fixture) => {
    const proxies = Array.isArray(fixture.collisionProxies)
      ? fixture.collisionProxies
      : fixture.collisionProxy ? [fixture.collisionProxy] : [];
    // A contact surface may support an apparatus or released object, but it is
    // still solid geometry for every robot link and finger.  Excluding these
    // proxies allowed the OpenArm mesh to pass through the visible worktops
    // while contact/grading continued from the same nominal tool point.
    return proxies.filter((proxy) => proxy.planningRole !== "robot_mount_contact")
      .map((proxy, index) => ({ id: `${fixture.id}:${proxy.id || index + 1}`, ...deepClone(proxy) }));
  });
}

function approach(current, target, velocity, maxVelocity, maxAcceleration, dt) {
  const difference = target - current;
  if (Math.abs(difference) <= 1e-12) return { position: target, velocity: 0 };
  const direction = Math.sign(difference);
  const brakingVelocity = Math.sqrt(Math.max(0, 2 * maxAcceleration * Math.abs(difference)));
  const desiredVelocity = direction * Math.min(maxVelocity, brakingVelocity);
  const velocityDelta = Math.max(-maxAcceleration * dt, Math.min(maxAcceleration * dt, desiredVelocity - velocity));
  const nextVelocity = velocity + velocityDelta;
  const step = nextVelocity * dt;
  if (Math.sign(target - (current + step)) !== direction || Math.abs(step) >= Math.abs(difference)) {
    return { position: target, velocity: 0 };
  }
  return { position: current + step, velocity: nextVelocity };
}

function publicOpenArmGripperToRenderer(value) {
  return Math.max(0, Math.min(45, -finite(value, "gripper.pos") * (45 / 65)));
}

function rendererOpenArmGripperToPublic(value) {
  return -Math.max(0, Math.min(45, Number(value) || 0)) * (65 / 45);
}

function profileKey(robotId) {
  if (robotId === "so101_follower") return "so101";
  if (robotId === "lekiwi_sim") return "lekiwi";
  if (robotId === "openarm_v2_bimanual") return "openarm";
  return "";
}

function boxAxes(box) {
  return Array.isArray(box?.axes) && box.axes.length === 3
    ? box.axes
    : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}

function pointBoxDistance(point, box) {
  const local = pointBoxCoordinates(point, box);
  return Math.hypot(...local.map((value, axis) => Math.max(0, Math.abs(value) - Number(box.halfExtentsMm[axis]))));
}

function pointObjectDistance(point, proxy) {
  if (proxy?.collisionParts?.length) return Math.min(...proxy.collisionParts.map((part) => pointObjectDistance(point, part)));
  if (proxy?.shape === "capsule") {
    const segment = proxy.endMm.map((value, axis) => value - proxy.startMm[axis]);
    const offset = point.map((value, axis) => value - proxy.startMm[axis]);
    const lengthSquared = segment.reduce((sum, value) => sum + value * value, 0);
    const fraction = lengthSquared > 1e-9
      ? Math.max(0, Math.min(1, offset.reduce((sum, value, axis) => sum + value * segment[axis], 0) / lengthSquared))
      : 0;
    const closest = proxy.startMm.map((value, axis) => value + segment[axis] * fraction);
    return Math.max(0, distance3(point, closest) - Number(proxy.radiusMm));
  }
  if (proxy?.footprintShape !== "ellipse") return pointBoxDistance(point, proxy);
  const local = pointBoxCoordinates(point, proxy);
  const [halfX, halfY, halfZ] = proxy.halfExtentsMm;
  const radial = Math.hypot(local[0] / Math.max(1e-9, halfX), local[2] / Math.max(1e-9, halfZ));
  const radialOutsideMm = Math.max(0, radial - 1) * Math.min(halfX, halfZ);
  const verticalOutsideMm = Math.max(0, Math.abs(local[1]) - halfY);
  return Math.hypot(radialOutsideMm, verticalOutsideMm);
}

function pointInsideObject(point, proxy) {
  if (proxy?.collisionParts?.length) return proxy.collisionParts.some((part) => pointInsideObject(point, part));
  if (proxy?.shape === "capsule") return pointObjectDistance(point, proxy) <= 1e-6;
  if (proxy?.footprintShape !== "ellipse") return pointInsideBox(point, proxy);
  const local = pointBoxCoordinates(point, proxy);
  const [halfX, halfY, halfZ] = proxy.halfExtentsMm;
  return Math.hypot(local[0] / Math.max(1e-9, halfX), local[2] / Math.max(1e-9, halfZ)) <= 1
    && Math.abs(local[1]) <= halfY;
}

function pointInsideBox(point, box) {
  const local = pointBoxCoordinates(point, box);
  return local.every((value, axis) => Math.abs(value) <= Number(box.halfExtentsMm[axis]) + 1e-6);
}

function pointBoxCoordinates(point, box) {
  const offset = point.map((value, axis) => Number(value) - Number(box.centerMm[axis]));
  return boxAxes(box).map((axis) => axis.reduce((sum, value, index) => sum + value * offset[index], 0));
}

function pointBoxSurfaceDistance(point, box) {
  if (box?.collisionParts?.length) {
    const containing = box.collisionParts.filter((part) => pointInsideObject(point, part));
    if (containing.length) return Math.min(...containing.map((part) => pointBoxSurfaceDistance(point, part)));
    return Math.min(...box.collisionParts.map((part) => pointObjectDistance(point, part)));
  }
  const local = pointBoxCoordinates(point, box);
  const outside = pointBoxDistance(point, box);
  if (outside > 0) return outside;
  return Math.min(...local.map((value, axis) => Number(box.halfExtentsMm[axis]) - Math.abs(value)));
}

function pointObjectPenetrationDepth(point, proxy) {
  if (!proxy) return 0;
  if (proxy.collisionParts?.length) {
    const containing = proxy.collisionParts.filter((part) => pointInsideObject(point, part));
    return containing.length ? Math.max(...containing.map((part) => pointObjectPenetrationDepth(point, part))) : 0;
  }
  if (proxy.shape === "capsule") {
    const segment = proxy.endMm.map((value, axis) => value - proxy.startMm[axis]);
    const offset = point.map((value, axis) => value - proxy.startMm[axis]);
    const lengthSquared = segment.reduce((sum, value) => sum + value * value, 0);
    const fraction = lengthSquared > 1e-9
      ? Math.max(0, Math.min(1, offset.reduce((sum, value, axis) => sum + value * segment[axis], 0) / lengthSquared))
      : 0;
    const closest = proxy.startMm.map((value, axis) => value + segment[axis] * fraction);
    return Math.max(0, Number(proxy.radiusMm) - distance3(point, closest));
  }
  const local = pointBoxCoordinates(point, proxy);
  if (proxy.footprintShape === "ellipse") {
    const [halfX, halfY, halfZ] = proxy.halfExtentsMm.map(Number);
    const radial = Math.hypot(local[0] / Math.max(1e-9, halfX), local[2] / Math.max(1e-9, halfZ));
    if (radial > 1 || Math.abs(local[1]) > halfY) return 0;
    const radialDepthMm = (1 - radial) * Math.min(halfX, halfZ);
    return Math.max(0, Math.min(radialDepthMm, halfY - Math.abs(local[1])));
  }
  if (!pointInsideBox(point, proxy)) return 0;
  return Math.max(0, Math.min(...local.map((value, axis) => Number(proxy.halfExtentsMm[axis]) - Math.abs(value))));
}

function pointObjectSurfaceDistance(point, proxy) {
  const penetrationMm = pointObjectPenetrationDepth(point, proxy);
  return penetrationMm > 0 ? penetrationMm : pointObjectDistance(point, proxy);
}

function sampleMatchesBody(sample, bodyId) {
  const sampleId = String(sample?.proxyId || sample?.id || "");
  return sampleId === bodyId || sampleId.startsWith(`${bodyId}-`) || sampleId.includes(bodyId);
}

export class PortableRobotPlant {
  constructor({ definition, model, runtimeState, onTick, tickSeconds = PORTABLE_PLANT_TICK_SECONDS, autoStart = false } = {}) {
    if (!definition || !model || !runtimeState) throw new Error("PortableRobotPlant requires definition, model, and runtimeState.");
    this.schema = PORTABLE_PLANT_SCHEMA;
    this.definition = definition;
    this.model = model;
    this.runtimeState = runtimeState;
    if (!Array.isArray(this.runtimeState.visitedFrames)) this.runtimeState.visitedFrames = [];
    if (!Array.isArray(this.runtimeState.eventLog)) this.runtimeState.eventLog = [];
    this.profileKey = profileKey(model.id);
    this.profile = this.profileKey ? compatibilityProfile(model.id) : null;
    this.tickSeconds = finite(tickSeconds, "tickSeconds");
    if (Math.abs(this.tickSeconds - PORTABLE_PLANT_TICK_SECONDS) > 1e-12) throw new Error("Portable plant tick must remain 0.020 seconds.");
    this.onTick = onTick;
    this.obstacles = fixtureObstacles(definition);
    this.baseline = {
      jointState: deepClone(runtimeState.jointState),
      rootPose: deepClone(runtimeState.rootPose),
      objects: deepClone(runtimeState.objects),
      processes: deepClone(runtimeState.processes),
    };
    this.timer = null;
    this.sleepWaiters = new Set();
    this.reset();
    if (autoStart && this.profile) this.start();
  }

  start() {
    if (this.timer || !this.profile) return false;
    this.timer = setInterval(() => this.tick(), this.tickSeconds * 1000);
    return true;
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.rejectWaiters(fail("PLANT_DISPOSED", "Portable robot plant was disposed."));
  }

  reset() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.rejectWaiters(fail("RESET", "Simulation reset replaced pending sleeps."));
    this.clockSeconds = 0;
    this.paused = false;
    this.stopped = false;
    this.fault = null;
    this.connected = new Map();
    this.commandedJointState = deepClone(this.baseline.jointState);
    this.jointVelocity = Object.fromEntries(Object.keys(this.baseline.jointState).map((jointId) => [jointId, 0]));
    this.baseCommand = { x: 0, y: 0, thetaDeg: 0 };
    this.baseVelocity = { x: 0, y: 0, thetaDeg: 0 };
    this.lastLeKiwiCommandSeconds = -Infinity;
    this.watchdogActive = false;
    this.contactLatches = new Map();
    this.supportContactConstraints = new Set();
    this.previousEffectorClosure = new Map();
    this.runtimeState.jointState = deepClone(this.baseline.jointState);
    this.runtimeState.rootPose = deepClone(this.baseline.rootPose);
    this.runtimeState.objects = deepClone(this.baseline.objects);
    this.runtimeState.processes = deepClone(this.baseline.processes);
    this.runtimeState.simulationClockSeconds = 0;
    this.runtimeState.plant = this.snapshot();
  }

  snapshot() {
    return deepClone({
      schema: this.schema,
      tickSeconds: this.tickSeconds,
      clockSeconds: this.clockSeconds,
      paused: this.paused,
      stopped: this.stopped,
      fault: this.fault,
      commandedJointState: this.commandedJointState,
      jointVelocity: this.jointVelocity,
      baseCommand: this.baseCommand,
      baseVelocity: this.baseVelocity,
      connectedInstances: [...this.connected.keys()],
      watchdogActive: this.watchdogActive,
    });
  }

  requireProfile() {
    if (!this.profile) throw fail("UNSUPPORTED_ROBOT", `${this.model.id} does not expose the portable Python runtime.`);
    if (this.fault) throw fail(this.fault.code, this.fault.message, this.fault);
  }

  connect(instanceId, config = {}) {
    this.requireProfile();
    const id = String(instanceId || "robot");
    if (this.connected.has(id)) throw fail("ALREADY_CONNECTED", `${id} is already connected.`);
    if (config.cameras && Object.keys(config.cameras).length) {
      throw fail("CAMERAS_UNSUPPORTED", "Cameras are not available in the browser simulation; pass cameras={}.");
    }
    if (this.profileKey === "openarm" && config.use_velocity_and_torque) {
      throw fail("SENSING_UNSUPPORTED", "OpenArm velocity/torque observations are hardware-only in this profile; use_velocity_and_torque must remain False.");
    }
    this.connected.set(id, deepClone(config));
    this.stopped = false;
    this.runtimeState.runState = "ready";
    this.event("CONNECTED", { instanceId: id, calibration: "preloaded_simulated" });
    return null;
  }

  disconnect(instanceId) {
    const id = String(instanceId || "robot");
    if (!this.connected.has(id)) throw fail("NOT_CONNECTED", `${id} is not connected.`);
    this.connected.delete(id);
    if (this.profileKey === "lekiwi") this.zeroMobileCommand("disconnect");
    this.event("DISCONNECTED", { instanceId: id });
    return null;
  }

  requireConnected(instanceId) {
    this.requireProfile();
    const id = String(instanceId || "robot");
    if (!this.connected.has(id)) throw fail("NOT_CONNECTED", `${id} is not connected.`);
    return this.connected.get(id);
  }

  publicJointMap(instanceId) {
    if (this.profileKey === "so101") {
      return Object.fromEntries(this.profile.actionFields.map((field) => [field.key, { jointId: field.jointId, toInternal: Number, fromInternal: Number }]));
    }
    if (this.profileKey === "lekiwi") {
      return {
        "arm_shoulder_pan.pos": { jointId: "shoulder_pan", toInternal: Number, fromInternal: Number },
        "arm_shoulder_lift.pos": { jointId: "shoulder_lift", toInternal: Number, fromInternal: Number },
        "arm_elbow_flex.pos": { jointId: "elbow_flex", toInternal: Number, fromInternal: Number },
        "arm_wrist_flex.pos": { jointId: "wrist_flex", toInternal: Number, fromInternal: Number },
        "arm_wrist_roll.pos": { jointId: "wrist_roll", toInternal: Number, fromInternal: Number },
        "arm_gripper.pos": { jointId: "gripper", toInternal: Number, fromInternal: Number },
      };
    }
    if (this.profileKey === "openarm") {
      const config = this.connected.get(String(instanceId || "robot")) || {};
      const bimanual = config.kind === "bimanual";
      const side = config.side === "right" ? "right" : "left";
      const map = {};
      const addSide = (which, prefix = "") => {
        for (let index = 1; index <= 7; index += 1) map[`${prefix}joint_${index}.pos`] = { jointId: `${which}_j${index}`, toInternal: Number, fromInternal: Number };
        map[`${prefix}gripper.pos`] = { jointId: `${which}_gripper`, toInternal: publicOpenArmGripperToRenderer, fromInternal: rendererOpenArmGripperToPublic };
      };
      if (bimanual) { addSide("left", "left_"); addSide("right", "right_"); }
      else addSide(side);
      return map;
    }
    return {};
  }

  sendAction(instanceId, action = {}, options = {}) {
    const config = this.requireConnected(instanceId);
    if (!action || typeof action !== "object" || Array.isArray(action)) throw fail("INVALID_ACTION", "send_action expects a dictionary.");
    if (options.customKp || options.customKd) throw fail("CUSTOM_GAINS_UNSUPPORTED", "Custom OpenArm hardware gains are unavailable in the browser simulation.");
    const entries = Object.entries(action);
    if (!entries.length) throw fail("EMPTY_ACTION", "send_action requires at least one recognized field.");

    if (this.profileKey === "lekiwi") return this.sendLeKiwiAction(action);

    const map = this.publicJointMap(instanceId);
    const unknown = entries.filter(([key]) => !Object.hasOwn(map, key)).map(([key]) => key);
    if (unknown.length) throw fail("INVALID_ACTION_FIELD", `Unsupported action field(s): ${unknown.join(", ")}.`);
    const sent = {};
    for (const [key, rawValue] of entries) {
      const mapping = map[key];
      let publicValue = finite(rawValue, key);
      let internalValue = mapping.toInternal(publicValue);
      if (this.profileKey === "openarm") {
        const side = mapping.jointId.startsWith("right_") ? "right" : "left";
        const motor = mapping.jointId.endsWith("_gripper") ? "gripper" : `joint_${mapping.jointId.match(/j(\d+)$/)?.[1]}`;
        const [minimum, maximum] = this.profile.lerobot[`${side}LimitsDeg`][motor];
        publicValue = Math.max(minimum, Math.min(maximum, publicValue));
        internalValue = mapping.toInternal(publicValue);
      }
      const joint = this.model.joints.find((item) => item.id === mapping.jointId);
      if (joint && (internalValue < joint.min || internalValue > joint.max)) {
        throw fail("SIMULATOR_JOINT_LIMIT", `${key}=${publicValue} is outside the reference-calibrated browser envelope ${joint.min}..${joint.max}.`, { upstreamClipping: false });
      }
      if (config.max_relative_target !== null && config.max_relative_target !== undefined) {
        const publicActual = mapping.fromInternal(this.runtimeState.jointState[mapping.jointId]);
        const limit = typeof config.max_relative_target === "number"
          ? config.max_relative_target
          : config.max_relative_target[key.replace(/\.pos$/, "")] ?? config.max_relative_target[mapping.jointId];
        if (!Number.isFinite(Number(limit))) throw fail("INVALID_MAX_RELATIVE_TARGET", `max_relative_target has no finite limit for ${key}.`);
        publicValue = publicActual + Math.max(-Number(limit), Math.min(Number(limit), publicValue - publicActual));
        internalValue = mapping.toInternal(publicValue);
      }
      this.commandedJointState[mapping.jointId] = internalValue;
      sent[key] = publicValue;
    }
    this.runtimeState.lastAction = deepClone(sent);
    this.event("COMMAND_TARGET_UPDATED", { instanceId, action: sent });
    return sent;
  }

  sendLeKiwiAction(action) {
    const allowed = new Set(this.profile.stateOrder);
    const unknown = Object.keys(action).filter((key) => !allowed.has(key));
    if (unknown.length) throw fail("INVALID_ACTION_FIELD", `Unsupported LeKiwi action field(s): ${unknown.join(", ")}.`);
    const values = Object.fromEntries(this.profile.stateOrder.map((key) => [key, finite(action[key] ?? 0, key)]));
    const map = this.publicJointMap("robot");
    Object.entries(map).forEach(([key, mapping]) => { this.commandedJointState[mapping.jointId] = values[key]; });
    this.baseCommand = { x: values["x.vel"], y: values["y.vel"], thetaDeg: values["theta.vel"] };
    this.lastLeKiwiCommandSeconds = this.clockSeconds;
    this.watchdogActive = false;
    this.runtimeState.lastAction = deepClone(values);
    this.event("COMMAND_TARGET_UPDATED", { instanceId: "lekiwi", action: values });
    return { values, vector: this.profile.stateOrder.map((key) => values[key]) };
  }

  getObservation(instanceId) {
    this.requireConnected(instanceId);
    const map = this.publicJointMap(instanceId);
    const observation = Object.fromEntries(Object.entries(map).map(([key, mapping]) => [key, mapping.fromInternal(this.runtimeState.jointState[mapping.jointId])]));
    if (this.profileKey === "lekiwi") {
      observation["x.vel"] = this.baseVelocity.x;
      observation["y.vel"] = this.baseVelocity.y;
      observation["theta.vel"] = this.baseVelocity.thetaDeg;
    }
    return observation;
  }

  clockNow() { return this.clockSeconds; }

  sleep(seconds) {
    const duration = finite(seconds, "sleep seconds");
    if (duration < 0) return Promise.reject(fail("INVALID_SLEEP", "sleep seconds must be non-negative."));
    if (this.stopped) return Promise.reject(fail("STOPPED", "Simulation is stopped."));
    const target = this.clockSeconds + duration;
    if (duration === 0) return Promise.resolve(null);
    return new Promise((resolve, reject) => this.sleepWaiters.add({ target, resolve, reject }));
  }

  pause() {
    this.paused = true;
    this.runtimeState.runState = "paused";
    this.event("PAUSED", { clockSeconds: this.clockSeconds });
  }

  resume() {
    if (this.stopped) throw fail("STOPPED", "Reset before resuming a stopped plant.");
    this.paused = false;
    this.runtimeState.runState = "running";
    this.event("RESUMED", { clockSeconds: this.clockSeconds });
  }

  stop(reason = "user") {
    this.stopped = true;
    this.paused = false;
    this.zeroMobileCommand("stop");
    Object.keys(this.jointVelocity).forEach((jointId) => { this.jointVelocity[jointId] = 0; });
    this.commandedJointState = deepClone(this.runtimeState.jointState);
    this.runtimeState.runState = "stopped";
    this.rejectWaiters(fail("STOPPED", `Simulation stopped: ${reason}`));
    this.event("STOPPED", { reason, clockSeconds: this.clockSeconds });
  }

  zeroMobileCommand(reason) {
    this.baseCommand = { x: 0, y: 0, thetaDeg: 0 };
    this.baseVelocity = { x: 0, y: 0, thetaDeg: 0 };
    if (reason === "watchdog") this.event("LEKIWI_WATCHDOG_STOP", { timeoutMs: 500 });
  }

  rejectWaiters(error) {
    for (const waiter of this.sleepWaiters || []) waiter.reject(error);
    this.sleepWaiters?.clear();
  }

  resolveWaiters() {
    for (const waiter of [...this.sleepWaiters]) {
      if (this.clockSeconds + 1e-12 >= waiter.target) {
        this.sleepWaiters.delete(waiter);
        waiter.resolve(null);
      }
    }
  }

  responseBounds(jointId) {
    if (this.profileKey === "so101") return jointId === "gripper" ? { velocity: 120, acceleration: 480 } : { velocity: 180, acceleration: 720 };
    if (this.profileKey === "lekiwi") return jointId === "gripper" ? { velocity: 120, acceleration: 480 } : { velocity: 180, acceleration: 720 };
    return { velocity: 120, acceleration: 480 };
  }

  tick() {
    if (!this.profile || this.paused || this.stopped || this.fault) return this.snapshot();
    const dt = this.tickSeconds;
    if (this.profileKey === "lekiwi" && this.clockSeconds - this.lastLeKiwiCommandSeconds >= 0.5 && !this.watchdogActive) {
      this.watchdogActive = true;
      this.zeroMobileCommand("watchdog");
    }

    const candidate = deepClone(this.runtimeState.jointState);
    const candidateVelocity = { ...this.jointVelocity };
    for (const joint of this.model.joints) {
      const target = Math.max(joint.min, Math.min(joint.max, Number(this.commandedJointState[joint.id] ?? candidate[joint.id] ?? joint.home)));
      const bounds = this.responseBounds(joint.id);
      const next = approach(Number(candidate[joint.id] ?? joint.home), target, Number(this.jointVelocity[joint.id] || 0), bounds.velocity, bounds.acceleration, dt);
      candidate[joint.id] = Math.max(joint.min, Math.min(joint.max, next.position));
      candidateVelocity[joint.id] = next.velocity;
    }

    const proposedBase = this.proposeBase(dt);
    this.applyGripperContactConstraints(candidate, candidateVelocity, proposedBase.rootPose);
    const collisionOptions = {
      basePose: proposedBase.rootPose,
      contactSurfaceClearanceMm: Number(this.definition.coordination?.tableClearance?.contactSurfaceClearanceMm ?? 1),
    };
    let collision = stateCollisionReport(this.model, candidate, this.obstacles, collisionOptions);
    let objectCollision = this.robotObjectCollisionReport(candidate, proposedBase.rootPose);
    let payloadCollision = this.payloadCollisionReport(candidate, proposedBase.rootPose);
    if (collision.ok && objectCollision.ok && !payloadCollision.ok && this.applyStableSupportConstraint(candidate, candidateVelocity, proposedBase, payloadCollision)) {
      collision = stateCollisionReport(this.model, candidate, this.obstacles, collisionOptions);
      objectCollision = this.robotObjectCollisionReport(candidate, proposedBase.rootPose);
      payloadCollision = this.payloadCollisionReport(candidate, proposedBase.rootPose);
    }
    if (!collision.ok || !objectCollision.ok || !payloadCollision.ok) {
      const witness = !collision.ok ? collision.collisions[0] : !objectCollision.ok ? objectCollision.collisions[0] : payloadCollision.collisions[0];
      this.fault = { code: "SIMULATOR_COLLISION_FAULT", message: "Incremental plant motion stopped at the last valid state after a configured robot, payload, or workcell collision.", collision: deepClone(witness), clockSeconds: this.clockSeconds };
      this.commandedJointState = deepClone(this.runtimeState.jointState);
      Object.keys(this.jointVelocity).forEach((jointId) => { this.jointVelocity[jointId] = 0; });
      this.zeroMobileCommand("collision");
      this.runtimeState.runState = "fault";
      this.event("SIMULATOR_FAULT", this.fault);
      this.rejectWaiters(fail(this.fault.code, this.fault.message, this.fault));
      this.runtimeState.plant = this.snapshot();
      this.onTick?.(this.snapshot(), this.runtimeState);
      return this.snapshot();
    }

    this.runtimeState.jointState = candidate;
    this.jointVelocity = candidateVelocity;
    this.runtimeState.rootPose = proposedBase.rootPose;
    this.baseVelocity = proposedBase.velocity;
    this.clockSeconds = Number((this.clockSeconds + dt).toFixed(12));
    this.runtimeState.simulationClockSeconds = this.clockSeconds;
    this.updateContactAndCarry();
    this.updateFreeFallObjects(dt);
    this.resolveWaiters();
    this.runtimeState.plant = this.snapshot();
    this.onTick?.(this.snapshot(), this.runtimeState);
    return this.snapshot();
  }

  proposeBase(dt) {
    if (this.profileKey !== "lekiwi") {
      return { rootPose: deepClone(this.runtimeState.rootPose), velocity: { ...this.baseVelocity } };
    }
    const accelerate = (current, target, maximumDelta) => current + Math.max(-maximumDelta, Math.min(maximumDelta, target - current));
    const linearDelta = { x: this.baseCommand.x - this.baseVelocity.x, y: this.baseCommand.y - this.baseVelocity.y };
    const linearMagnitude = Math.hypot(linearDelta.x, linearDelta.y);
    const linearScale = linearMagnitude > 0.8 * dt ? (0.8 * dt) / linearMagnitude : 1;
    const nextX = this.baseVelocity.x + linearDelta.x * linearScale;
    const nextY = this.baseVelocity.y + linearDelta.y * linearScale;
    const nextTheta = accelerate(this.baseVelocity.thetaDeg, this.baseCommand.thetaDeg, 240 * dt);
    const velocity = { x: nextX, y: nextY, thetaDeg: nextTheta };
    const rootPose = deepClone(this.runtimeState.rootPose);
    const headingRad = this.runtimeState.rootPose.headingDeg * Math.PI / 180;
    const worldX = velocity.x * Math.cos(headingRad) - velocity.y * Math.sin(headingRad);
    const worldY = velocity.x * Math.sin(headingRad) + velocity.y * Math.cos(headingRad);
    rootPose.positionMm[0] += worldX * dt * 1000;
    rootPose.positionMm[2] -= worldY * dt * 1000;
    rootPose.headingDeg += velocity.thetaDeg * dt;
    return { rootPose, velocity };
  }

  effectorStates() {
    if (this.profileKey === "openarm") {
      return ["left", "right"].map((side) => {
        const fk = forwardKinematics(this.model, this.runtimeState.jointState, { chainId: side, basePose: this.runtimeState.rootPose });
        return {
          id: side,
          positionMm: fk.positionMm,
          rotationMatrix: [...fk.transform.rotation],
          transform: { position: [...fk.positionMm], rotation: [...fk.transform.rotation] },
          closed: Number(this.runtimeState.jointState[`${side}_gripper`] || 0) <= 8,
          open: Number(this.runtimeState.jointState[`${side}_gripper`] || 0) >= 28,
        };
      });
    }
    const chainId = Object.keys(this.model.chains)[0];
    const fk = forwardKinematics(this.model, this.runtimeState.jointState, { chainId, basePose: this.runtimeState.rootPose });
    return [{
      id: "default",
      positionMm: fk.positionMm,
      rotationMatrix: [...fk.transform.rotation],
      transform: { position: [...fk.positionMm], rotation: [...fk.transform.rotation] },
      closed: Number(this.runtimeState.jointState.gripper || 0) >= 70,
      open: Number(this.runtimeState.jointState.gripper || 0) <= 35,
    }];
  }

  updateContactAndCarry() {
    const effectors = this.effectorStates();
    this.updateVisitedFrames(effectors);
    for (const effector of effectors) {
      const wasClosed = this.previousEffectorClosure.get(effector.id) === true;
      const held = Object.values(this.runtimeState.objects).find((object) => object.attachedTo === effector.id);
      if (held) {
        if (!held.attachmentTransform) {
          this.fault = {
            code: "INVALID_ATTACHMENT_TRANSFORM",
            message: "Portable apparatus cannot be carried without a live contact-captured attachment transform.",
            objectId: held.id,
            effector: effector.id,
            clockSeconds: this.clockSeconds,
          };
          this.commandedJointState = deepClone(this.runtimeState.jointState);
          Object.keys(this.jointVelocity).forEach((jointId) => { this.jointVelocity[jointId] = 0; });
          this.runtimeState.runState = "fault";
          this.event("SIMULATOR_FAULT", this.fault);
          this.previousEffectorClosure.set(effector.id, effector.closed);
          continue;
        }
        const carriedPose = composeTransform(effector.transform, held.attachmentTransform);
        held.worldPositionMm = [...carriedPose.position];
        held.worldRotationMatrix = [...carriedPose.rotation];
        held.currentFrame = "";
        this.contactLatches.delete(effector.id);
        const physicalPinchHold = ["robobuddy.opposed-pinch.v1", "robobuddy.surface-pinch.v1", "robobuddy.sampled-pinch.v1"].includes(held.graspConstraint?.schema);
        const opposedPinchHold = held.graspConstraint?.schema === "robobuddy.opposed-pinch.v1";
        const holdReport = opposedPinchHold
          ? this.opposedPinchContactReport(held, effector.id, this.runtimeState.jointState, this.runtimeState.rootPose)
          : null;
        const holdJointId = held.graspConstraint?.gripperJointId || (this.profileKey === "openarm" ? `${effector.id}_gripper` : "gripper");
        const closeDirection = Number(held.graspConstraint?.closeDirection ?? (this.profileKey === "openarm" ? -1 : 1));
        const openedFromContact = closeDirection * (
          Number(this.runtimeState.jointState[holdJointId]) - Number(held.graspConstraint?.gripperValue)
        ) < -0.05;
        const shouldRelease = physicalPinchHold
          ? openedFromContact && (!opposedPinchHold || !holdReport?.ok)
          : effector.open;
        if (shouldRelease) {
          const candidates = Object.entries(this.definition.frames || {}).filter(([, frame]) => !frame.chainId || frame.chainId === effector.id)
            .map(([id, frame]) => ({ id, frame, distance: distance3(effector.positionMm, frame.positionMm) }));
          const contact = candidates.filter(({ frame }) => frame.role === "contact").sort((a, b) => a.distance - b.distance)[0];
          const destination = candidates
            .filter(({ frame }) => ["contact", "destination"].includes(frame.role))
            .sort((a, b) => a.distance - b.distance)[0];
          const tolerance = Number(destination?.frame?.tolerance?.positionMm ?? 22);
          let releasedFrame = destination && destination.distance <= tolerance ? destination.id : "world";
          if (contact && contact.distance <= Number(contact.frame?.tolerance?.positionMm ?? 22) && /(place|delivery|handoff)/i.test(contact.id)) {
            const nearbyDestination = candidates.filter(({ frame }) => frame.role === "destination").sort((a, b) => a.distance - b.distance)[0];
            if (nearbyDestination && nearbyDestination.distance <= 180) releasedFrame = nearbyDestination.id;
          }
          const stableDeclaredRest = Object.keys(held.physicalRest?.poses || {})
            .map((frameId) => ({ frameId, report: validateRestPose(this.definition, held, carriedPose, frameId) }))
            .filter((candidate) => candidate.report.ok)
            .sort((a, b) => a.report.targetPositionErrorMm - b.report.targetPositionErrorMm)[0];
          if (stableDeclaredRest && (releasedFrame === "world" || !validateRestPose(this.definition, held, carriedPose, releasedFrame).ok)) {
            releasedFrame = stableDeclaredRest.frameId;
          }
          const restReport = releasedFrame === "world"
            ? { ok: false, reasons: ["opened gripper was not at a declared stable destination"] }
            : validateRestPose(this.definition, held, carriedPose, releasedFrame);
          if (restReport.ok) {
            const declaredContactFrame = held.physicalRest?.poses?.[releasedFrame]?.graspFrameId || releasedFrame;
            this.event("PLACE_CONTACT", { objectId: held.id, effector: effector.id, frameId: contact?.distance <= Number(contact?.frame?.tolerance?.positionMm ?? 22) ? contact.id : declaredContactFrame, distanceMm: contact?.distance ?? destination?.distance ?? 0, rest: deepClone(restReport) });
          } else {
            this.event("REST_POSE_REJECTED", { objectId: held.id, effector: effector.id, requestedFrameId: releasedFrame, reasons: restReport.reasons || [] });
            releasedFrame = "world";
          }
          held.attachedTo = "";
          held.attachmentInterface = "";
          held.currentFrame = releasedFrame;
          held.worldPositionMm = [...carriedPose.position];
          held.worldRotationMatrix = [...carriedPose.rotation];
          held.attachmentTransform = null;
          held.graspConstraint = null;
          held.releasedUnsupported = !restReport.ok;
          held.freeFallVelocityMmPerS = [0, 0, 0];
          this.event("DETACH_OBJECT", { objectId: held.id, effector: effector.id, frameId: held.currentFrame, stableRest: restReport.ok, unsupportedRelease: !restReport.ok, worldPositionMm: held.worldPositionMm, worldRotationMatrix: held.worldRotationMatrix });
        }
        this.previousEffectorClosure.set(effector.id, effector.closed);
        continue;
      }
      const candidate = Object.values(this.runtimeState.objects).filter((object) => {
        const allowed = object.compatibleEffectors || object.allowedEffectors || [];
        const availableForTaskGrasp = this.profileKey !== "so101" || object.currentFrame === object.initialFrame;
        return !object.attachedTo && availableForTaskGrasp && (!allowed.length || allowed.includes(effector.id));
      })
        .map((object) => {
          const semanticFrameId = object.currentFrame || object.initialFrame;
          const gripFrameId = object.physicalRest?.poses?.[semanticFrameId]?.graspFrameId || semanticFrameId;
          const frame = this.definition.frames?.[gripFrameId];
          const position = frame?.positionMm;
          return position ? { object, position, distance: distance3(effector.positionMm, position), tolerance: Number(frame?.tolerance?.positionMm ?? 18), gripFrameId } : null;
        }).filter(Boolean).sort((a, b) => a.distance - b.distance)[0];
      if (candidate && candidate.distance <= Math.max(80, candidate.tolerance)) {
        candidate.fingerContact = this.objectFingerContactReport(candidate.object, effector.id, this.runtimeState.jointState, this.runtimeState.rootPose);
      }
      const opposedContact = candidate?.fingerContact?.schema === "robobuddy.opposed-pinch.v1";
      const surfaceContact = candidate?.fingerContact?.schema === "robobuddy.surface-pinch.v1";
      const sampledContact = candidate?.fingerContact?.schema === "robobuddy.sampled-pinch.v1";
      const physicalPinchContact = opposedContact || surfaceContact || sampledContact;
      const liveContact = candidate && physicalPinchContact
        && candidate.fingerContact.contactBodies.length > 0
        && candidate.distance <= Math.max(80, candidate.tolerance) ? candidate : null;
      if (!effector.closed || physicalPinchContact) {
        if (!liveContact) this.contactLatches.delete(effector.id);
        else {
          const contactFrameId = liveContact.gripFrameId;
          const existing = this.contactLatches.get(effector.id);
          if (!existing || existing.objectId !== liveContact.object.id || existing.frameId !== contactFrameId) {
            const gripperJointId = this.gripperJointId(effector.id);
            this.contactLatches.set(effector.id, { objectId: liveContact.object.id, frameId: contactFrameId, clockSeconds: this.clockSeconds, gripperValue: Number(this.runtimeState.jointState[gripperJointId]) });
            this.event("CONTACT", { objectId: liveContact.object.id, effector: effector.id, frameId: contactFrameId, distanceMm: liveContact.distance, contactBodies: [...liveContact.fingerContact.contactBodies] });
          }
        }
      }
      const latch = this.contactLatches.get(effector.id);
      const gripperJointId = this.gripperJointId(effector.id);
      const closeDirection = this.gripperCloseDirection(effector.id);
      const closingOrHolding = closeDirection * (
        Number(this.commandedJointState[gripperJointId]) - Number(this.runtimeState.jointState[gripperJointId])
      ) >= -1e-6;
      const closureAfterContact = latch && closeDirection * (
        Number(this.runtimeState.jointState[gripperJointId]) - Number(latch.gripperValue)
      ) > 0.05;
      const closureAppliedBeforeContact = closeDirection * (
        Number(this.runtimeState.jointState[gripperJointId]) - this.gripperOpenValue(effector.id)
      ) > 0.05;
      const readyToAttach = physicalPinchContact && liveContact?.fingerContact?.ok && closingOrHolding
        && (closureAfterContact || closureAppliedBeforeContact);
      if (readyToAttach && liveContact && latch?.objectId === liveContact.object.id) {
        const objectPose = objectWorldTransform(liveContact.object);
        const restFrame = liveContact.object.currentFrame || liveContact.object.initialFrame;
        if (!objectPose) {
          this.event("GRASP_REJECTED", { objectId: liveContact.object.id, effector: effector.id, frameId: restFrame, reasons: ["authoritative object world pose is unavailable"] });
          this.contactLatches.delete(effector.id);
          this.previousEffectorClosure.set(effector.id, effector.closed);
          continue;
        }
        const restReport = validateRestPose(this.definition, liveContact.object, objectPose, restFrame);
        if (!restReport.ok) {
          this.event("GRASP_REJECTED", { objectId: liveContact.object.id, effector: effector.id, frameId: restFrame, reasons: restReport.reasons || [] });
          this.contactLatches.delete(effector.id);
          this.previousEffectorClosure.set(effector.id, effector.closed);
          continue;
        }
        const fingerContact = this.objectFingerContactReport(liveContact.object, effector.id, this.runtimeState.jointState, this.runtimeState.rootPose);
        if (!fingerContact.ok) {
          this.previousEffectorClosure.set(effector.id, effector.closed);
          continue;
        }
        liveContact.object.attachmentTransform = composeTransform(inverseTransform(effector.transform), objectPose);
        liveContact.object.currentFrame = "";
        liveContact.object.attachedTo = effector.id;
        liveContact.object.attachmentInterface = liveContact.object.configuredAttachmentInterface || "gripper";
        liveContact.object.graspConstraint = {
          schema: fingerContact.schema,
          gripperJointId,
          closeDirection,
          gripperValue: Number(this.runtimeState.jointState[gripperJointId]),
          maxPenetrationMm: Number(fingerContact.maxPenetrationMm),
          ...(Number.isFinite(fingerContact.capturedThicknessMm) ? { capturedThicknessMm: fingerContact.capturedThicknessMm } : {}),
          ...(Number.isFinite(fingerContact.expectedThicknessMm) ? { expectedThicknessMm: fingerContact.expectedThicknessMm } : {}),
          ...(Number.isFinite(fingerContact.alignmentDeg) ? { alignmentDeg: fingerContact.alignmentDeg } : {}),
          witnesses: deepClone(fingerContact.witnesses),
        };
        liveContact.object.releasedUnsupported = false;
        liveContact.object.freeFallVelocityMmPerS = [0, 0, 0];
        this.event("ATTACH_OBJECT", { objectId: liveContact.object.id, effector: effector.id, frameId: latch.frameId, attachmentInterface: liveContact.object.attachmentInterface, contactClockSeconds: latch.clockSeconds, contactBodies: fingerContact.contactBodies, opposedPinch: opposedContact, physicalPinch: true, graspConstraint: deepClone(liveContact.object.graspConstraint) });
        this.contactLatches.delete(effector.id);
      }
      this.previousEffectorClosure.set(effector.id, effector.closed);
    }
    this.commitPhysicalProcesses();
  }

  payloadCollisionReport(jointState, basePose) {
    const effectors = new Map(this.effectorStatesFor(jointState, basePose).map((effector) => [effector.id, effector]));
    const collisions = [];
    const carried = Object.values(this.runtimeState.objects).filter((object) => object.attachedTo && object.attachmentTransform);
    for (const object of carried) {
      const effector = effectors.get(object.attachedTo);
      if (!effector) continue;
      const pose = composeTransform(effector.transform, object.attachmentTransform);
      const proxy = physicalObjectProxy(object, pose);
      if (!proxy) continue;
      for (const obstacle of this.obstacles.filter((item) => item.type === "box")) {
        if (!proxiesCollide(proxy, obstacle)) continue;
        const restReports = Object.keys(object.physicalRest?.poses || {}).filter((frameId) => (
          object.physicalRest.poses[frameId].surfaceId === obstacle.id
        )).map((frameId) => ({
          frameId,
          // During the final vertical approach the payload may first touch its
          // own declared work surface before the opened gripper commits the
          // exact destination frame. Permit only geometrically stable,
          // nonpenetrating support contact here; target-frame proximity remains
          // mandatory at release in updateContactAndCarry().
          ...validateRestPose(this.definition, object, pose, frameId, {
            targetPositionToleranceMm: Number.POSITIVE_INFINITY,
          }),
        }));
        const declaredStableContact = restReports.some((report) => report.ok);
        if (!declaredStableContact) collisions.push({
          payloadId: object.id,
          obstacleId: obstacle.id,
          geometry: "payload-oriented-box",
          pose: deepClone(pose),
          restReports: restReports.map((report) => ({
            frameId: report.frameId,
            reasons: report.reasons,
            tiltDeg: report.tiltDeg,
            gapMm: report.gapMm,
            targetPositionErrorMm: report.targetPositionErrorMm,
          })),
        });
      }
      for (const other of Object.values(this.runtimeState.objects).filter((item) => item.id !== object.id && !item.attachedTo)) {
        const otherProxy = physicalObjectProxy(other);
        if (otherProxy && proxiesCollide(proxy, otherProxy)) collisions.push({ payloadId: object.id, obstacleId: other.id, geometry: "payload-object-oriented-box" });
      }
      const allowedBodies = this.contactBodiesFor(object, object.attachedTo);
      for (const sample of sampleRenderedGeometry(this.model, jointState, { basePose })) {
        if (!pointInsideObject(sample.pointMm, proxy)) continue;
        const allowedContact = allowedBodies.some((bodyId) => sampleMatchesBody(sample, bodyId));
        const maxPenetrationMm = Number(object.graspConstraint?.maxPenetrationMm ?? object.physicalRest?.tolerance?.maxPenetrationMm ?? 0.5);
        if (allowedContact && (object.graspConstraint?.schema === "robobuddy.sampled-pinch.v1"
          || pointObjectPenetrationDepth(sample.pointMm, proxy) <= maxPenetrationMm + 1e-6)) continue;
        collisions.push({ payloadId: object.id, obstacleId: sample.proxyId || sample.id, geometry: "payload-robot-baked-renderer-sample", pointMm: [...sample.pointMm] });
      }
    }
    return { ok: collisions.length === 0, collisions };
  }

  contactBodiesFor(object, effectorId) {
    const configured = (this.definition.grasps || []).find((grasp) => grasp.objectId === object.id && grasp.effector === effectorId);
    if (configured?.allowedRobotContactBodies?.length) return [...configured.allowedRobotContactBodies];
    if (this.profileKey === "openarm") return [`${effectorId}_finger_inner`, `${effectorId}_finger_outer`];
    if (this.profileKey === "so101") return ["gripper_link__", "moving_jaw_so101_v1_link__"];
    if (this.profileKey === "lekiwi") return ["wrist_roll_08c_v1__", "moving_jaw_08d_v1__"];
    return [];
  }

  configuredGraspFor(object, effectorId) {
    return (this.definition.grasps || []).find((grasp) => grasp.objectId === object.id && grasp.effector === effectorId) || null;
  }

  gripperJointId(effectorId) {
    return this.profileKey === "openarm" ? `${effectorId}_gripper` : "gripper";
  }

  gripperCloseDirection() {
    return this.profileKey === "openarm" ? -1 : 1;
  }

  gripperOpenValue(effectorId) {
    const joint = this.model.joints.find((item) => item.id === this.gripperJointId(effectorId));
    return Number(joint?.open ?? (this.profileKey === "openarm" ? 45 : this.profileKey === "lekiwi" ? 20 : 0));
  }

  opposedPinchContactReport(object, effectorId, jointState, basePose) {
    const configured = this.configuredGraspFor(object, effectorId)?.physicalContact;
    const pose = objectWorldTransform(object);
    const witnesses = configured ? gripperContactWitnesses(this.model, jointState, { basePose }) : null;
    if (!configured || configured.schema !== "robobuddy.opposed-pinch.v1" || !pose || !witnesses) return null;
    const geometry = object.physicalRest?.geometry;
    if (!geometry?.centerLocalMm || !geometry?.halfExtentsMm) return null;
    const objectInverse = inverseTransform(pose);
    const fixedLocalMm = transformPoint(objectInverse, witnesses.fixed.pointMm);
    const movingLocalMm = transformPoint(objectInverse, witnesses.moving.pointMm);
    const contactCenterMm = Number(configured.bandCenterLocalMm?.[0] ?? geometry.centerLocalMm[0]);
    const contactHalfExtentMm = Number(configured.contactHalfExtentMm ?? geometry.halfExtentsMm[0]);
    const negativeFaceMm = contactCenterMm - contactHalfExtentMm;
    const positiveFaceMm = contactCenterMm + contactHalfExtentMm;
    const fixedFaceSign = Number(configured.fixedFaceSign || -1);
    const movingFaceSign = -fixedFaceSign;
    const fixedFaceMm = fixedFaceSign > 0 ? positiveFaceMm : negativeFaceMm;
    const movingFaceMm = movingFaceSign > 0 ? positiveFaceMm : negativeFaceMm;
    const fixedFaceSignedMm = fixedLocalMm[0] - fixedFaceMm;
    const movingFaceSignedMm = movingLocalMm[0] - movingFaceMm;
    const separation = fixedLocalMm.map((value, axis) => fixedFaceSign * (value - movingLocalMm[axis]));
    const alignmentDeg = Math.atan2(Math.hypot(separation[1], separation[2]), Math.max(1e-9, separation[0])) * 180 / Math.PI;
    const bandCenter = configured.bandCenterLocalMm;
    const bandHalf = configured.bandHalfExtentsMm;
    const inBand = (point) => [1, 2].every((axis) => Math.abs(point[axis] - Number(bandCenter[axis])) <= Number(bandHalf[axis]) + 1e-6);
    const toleranceMm = Number(configured.contactToleranceMm ?? 1.5);
    const maxPenetrationMm = Number(configured.maxPenetrationMm ?? 1);
    const fixedPenetrationMm = Math.max(0, -fixedFaceSign * fixedFaceSignedMm);
    const movingPenetrationMm = Math.max(0, -movingFaceSign * movingFaceSignedMm);
    const fixedOutsideSignedMm = fixedFaceSign * fixedFaceSignedMm;
    const movingOutsideSignedMm = movingFaceSign * movingFaceSignedMm;
    const rendererSurface = (point) => {
      if (!Array.isArray(geometry.radialProfileMm)) return null;
      const radiusMm = radialSurfaceRadiusAtHeight(geometry.radialProfileMm, point[1]);
      if (!Number.isFinite(radiusMm)) return null;
      const radialDistanceMm = Math.hypot(
        point[0] - Number(geometry.centerLocalMm[0]),
        point[2] - Number(geometry.centerLocalMm[2]),
      );
      const signedMm = radialDistanceMm - radiusMm;
      return { radiusMm, radialDistanceMm, signedMm, gapMm: Math.abs(signedMm), penetrationMm: Math.max(0, -signedMm) };
    };
    const fixedRendererSurface = rendererSurface(fixedLocalMm);
    const movingRendererSurface = rendererSurface(movingLocalMm);
    const capturedThicknessMm = fixedFaceSign * (fixedLocalMm[0] - movingLocalMm[0]);
    const reasons = [];
    if (Math.abs(fixedFaceSignedMm) > toleranceMm) reasons.push(`fixed jaw is ${Math.abs(fixedFaceSignedMm).toFixed(3)} mm from its configured face`);
    if (Math.abs(movingFaceSignedMm) > toleranceMm) reasons.push(`moving jaw is ${Math.abs(movingFaceSignedMm).toFixed(3)} mm from its configured face`);
    if (fixedRendererSurface?.gapMm > toleranceMm) reasons.push(`fixed jaw is ${fixedRendererSurface.gapMm.toFixed(3)} mm from the rendered radial surface`);
    if (movingRendererSurface?.gapMm > toleranceMm) reasons.push(`moving jaw is ${movingRendererSurface.gapMm.toFixed(3)} mm from the rendered radial surface`);
    if (!inBand(fixedLocalMm) || !inBand(movingLocalMm)) reasons.push("jaw witness is outside the configured grip band");
    if (fixedPenetrationMm > maxPenetrationMm || movingPenetrationMm > maxPenetrationMm
      || fixedRendererSurface?.penetrationMm > maxPenetrationMm || movingRendererSurface?.penetrationMm > maxPenetrationMm) reasons.push("jaw penetration exceeds the physical-world contact limit");
    if (Math.abs(capturedThicknessMm - Number(configured.capturedThicknessMm)) > toleranceMm * 2) reasons.push("opposed jaws do not capture the configured apparatus thickness");
    if (alignmentDeg > Number(configured.alignmentToleranceDeg ?? 14)) reasons.push(`opposed-jaw axis is misaligned by ${alignmentDeg.toFixed(3)} deg`);
    const contactBodies = [];
    if (Math.abs(fixedFaceSignedMm) <= toleranceMm && (!fixedRendererSurface || fixedRendererSurface.gapMm <= toleranceMm) && inBand(fixedLocalMm)) contactBodies.push(configured.fixedBodyId);
    if (Math.abs(movingFaceSignedMm) <= toleranceMm && (!movingRendererSurface || movingRendererSurface.gapMm <= toleranceMm) && inBand(movingLocalMm)) contactBodies.push(configured.movingBodyId);
    return {
      ok: reasons.length === 0,
      schema: configured.schema,
      reasons,
      requiredBodies: [configured.fixedBodyId, configured.movingBodyId],
      contactBodies,
      witnesses: {
        fixed: { bodyId: configured.fixedBodyId, pointMm: witnesses.fixed.pointMm, objectLocalMm: fixedLocalMm, faceSignedMm: fixedFaceSignedMm, outsideSignedMm: fixedOutsideSignedMm, inBand: inBand(fixedLocalMm), penetrationMm: Math.max(fixedPenetrationMm, fixedRendererSurface?.penetrationMm || 0), ...(fixedRendererSurface ? { rendererSurface: fixedRendererSurface } : {}) },
        moving: { bodyId: configured.movingBodyId, pointMm: witnesses.moving.pointMm, objectLocalMm: movingLocalMm, faceSignedMm: movingFaceSignedMm, outsideSignedMm: movingOutsideSignedMm, penetrationMm: Math.max(movingPenetrationMm, movingRendererSurface?.penetrationMm || 0), ...(movingRendererSurface ? { rendererSurface: movingRendererSurface } : {}) },
      },
      capturedThicknessMm,
      expectedThicknessMm: Number(configured.capturedThicknessMm),
      alignmentDeg,
      toleranceMm,
      maxPenetrationMm,
      sampleCount: 2,
    };
  }

  applyGripperContactConstraints(candidate, candidateVelocity, basePose) {
    if (["openarm", "lekiwi"].includes(this.profileKey)) {
      let constrained = false;
      const effectors = this.profileKey === "openarm" ? ["left", "right"] : ["default"];
      for (const effectorId of effectors) {
        const jointId = this.gripperJointId(effectorId);
        const closeDirection = this.gripperCloseDirection(effectorId);
        const currentValue = Number(this.runtimeState.jointState[jointId]);
        const held = Object.values(this.runtimeState.objects).find((object) => (
          object.attachedTo === effectorId && ["robobuddy.surface-pinch.v1", "robobuddy.sampled-pinch.v1"].includes(object.graspConstraint?.schema)
        ));
        if (held) {
          const holdValue = Number(held.graspConstraint.gripperValue);
          if (closeDirection * (Number(candidate[jointId]) - holdValue) > 1e-9) {
            candidate[jointId] = holdValue;
            candidateVelocity[jointId] = 0;
            constrained = true;
          }
          continue;
        }
        if (closeDirection * (Number(candidate[jointId]) - currentValue) <= 1e-9) continue;
        const objects = Object.values(this.runtimeState.objects).filter((object) => {
          const allowed = object.compatibleEffectors || object.allowedEffectors || [];
          return !object.attachedTo && (!allowed.length || allowed.includes(effectorId));
        });
        for (const object of objects) {
          const proposed = this.objectFingerContactReport(object, effectorId, candidate, basePose);
          if (proposed.schema !== "robobuddy.surface-pinch.v1"
            || proposed.maxPenetrationMmObserved <= proposed.maxPenetrationMm + 1e-6) continue;
          const atCurrentGripper = { ...candidate, [jointId]: currentValue };
          const current = this.objectFingerContactReport(object, effectorId, atCurrentGripper, basePose);
          if (current.maxPenetrationMmObserved > current.maxPenetrationMm + 1e-6) continue;
          let safeFraction = 0;
          let penetratingFraction = 1;
          for (let iteration = 0; iteration < 28; iteration += 1) {
            const fraction = (safeFraction + penetratingFraction) / 2;
            const trial = { ...candidate, [jointId]: currentValue + (Number(candidate[jointId]) - currentValue) * fraction };
            const report = this.objectFingerContactReport(object, effectorId, trial, basePose);
            if (report.maxPenetrationMmObserved <= report.maxPenetrationMm + 1e-6) safeFraction = fraction;
            else penetratingFraction = fraction;
          }
          candidate[jointId] = currentValue + (Number(candidate[jointId]) - currentValue) * safeFraction;
          candidateVelocity[jointId] = 0;
          constrained = true;
          break;
        }
      }
      return constrained;
    }
    if (this.profileKey !== "so101") return false;
    const currentValue = Number(this.runtimeState.jointState.gripper);
    const held = Object.values(this.runtimeState.objects).find((object) => object.attachedTo === "default" && object.graspConstraint);
    if (held) {
      const holdValue = Number(held.graspConstraint.gripperValue);
      if (Number(candidate.gripper) > holdValue) {
        candidate.gripper = holdValue;
        candidateVelocity.gripper = 0;
        return true;
      }
      return false;
    }
    let constrained = false;
    for (const object of Object.values(this.runtimeState.objects).filter((item) => !item.attachedTo && item.currentFrame === item.initialFrame)) {
      if (!this.configuredGraspFor(object, "default")?.physicalContact) continue;
      const current = this.opposedPinchContactReport(object, "default", this.runtimeState.jointState, basePose);
      const next = this.opposedPinchContactReport(object, "default", candidate, basePose);
      if (!current || !next || !next.witnesses.fixed.inBand) continue;
      const minimumOutsideMm = -next.maxPenetrationMm;
      if (!(next.witnesses.fixed.outsideSignedMm < current.witnesses.fixed.outsideSignedMm - 1e-9)
        || next.witnesses.fixed.outsideSignedMm >= minimumOutsideMm) continue;
      let safeFraction = 0;
      let contactFraction = 1;
      if (current.witnesses.fixed.outsideSignedMm > minimumOutsideMm) {
        for (let iteration = 0; iteration < 28; iteration += 1) {
          const fraction = (safeFraction + contactFraction) / 2;
          const trial = { ...candidate };
          for (const joint of this.model.joints.filter((item) => item.id !== "gripper")) {
            const start = Number(this.runtimeState.jointState[joint.id]);
            trial[joint.id] = start + (Number(candidate[joint.id]) - start) * fraction;
          }
          const report = this.opposedPinchContactReport(object, "default", trial, basePose);
          if (report?.witnesses.fixed.outsideSignedMm > minimumOutsideMm) safeFraction = fraction;
          else contactFraction = fraction;
        }
      } else contactFraction = 0;
      for (const joint of this.model.joints.filter((item) => item.id !== "gripper")) {
        const start = Number(this.runtimeState.jointState[joint.id]);
        candidate[joint.id] = start + (Number(candidate[joint.id]) - start) * contactFraction;
        candidateVelocity[joint.id] = 0;
      }
      constrained = true;
      break;
    }
    if (!(Number(candidate.gripper) > currentValue + 1e-9)) return constrained;
    for (const object of Object.values(this.runtimeState.objects).filter((item) => !item.attachedTo && item.currentFrame === item.initialFrame)) {
      if (!this.configuredGraspFor(object, "default")?.physicalContact) continue;
      const current = this.opposedPinchContactReport(object, "default", this.runtimeState.jointState, basePose);
      const next = this.opposedPinchContactReport(object, "default", candidate, basePose);
      if (!current || !next || current.witnesses.moving.outsideSignedMm < -next.toleranceMm) continue;
      if (next.witnesses.moving.outsideSignedMm > 0) continue;
      let outside = currentValue;
      let inside = Number(candidate.gripper);
      for (let iteration = 0; iteration < 28; iteration += 1) {
        const middle = (outside + inside) / 2;
        const trial = { ...candidate, gripper: middle };
        const report = this.opposedPinchContactReport(object, "default", trial, basePose);
        if (!report || report.witnesses.moving.outsideSignedMm > 0) outside = middle;
        else inside = middle;
      }
      const limited = { ...candidate, gripper: inside };
      const contact = this.opposedPinchContactReport(object, "default", limited, basePose);
      if (!contact) continue;
      candidate.gripper = inside;
      candidateVelocity.gripper = 0;
      return true;
    }
    return constrained;
  }

  objectFingerContactReport(object, effectorId, jointState, basePose) {
    const opposed = this.opposedPinchContactReport(object, effectorId, jointState, basePose);
    if (opposed) return opposed;
    const proxy = physicalObjectProxy(object);
    const requiredBodies = this.contactBodiesFor(object, effectorId);
    const maxPenetrationMm = Math.min(0.5, Number(object.physicalRest?.tolerance?.maxPenetrationMm ?? 0.5));
    const toleranceMm = 1.5;
    if (!proxy || requiredBodies.length < 2) return {
      ok: false,
      schema: "robobuddy.surface-pinch.v1",
      requiredBodies,
      contactBodies: [],
      sampleCount: 0,
      toleranceMm,
      maxPenetrationMm,
      maxPenetrationMmObserved: 0,
      witnesses: {},
      reasons: ["two configured opposing finger bodies and an authoritative object proxy are required"],
    };
    const denseContactSamples = this.profileKey === "openarm"
      ? sampleContactGeometry(this.model, jointState, { basePose, bodyIds: requiredBodies })
      : [];
    const samples = denseContactSamples.length ? denseContactSamples : sampleRenderedGeometry(this.model, jointState, { basePose });
    if (this.profileKey === "lekiwi") {
      const witnesses = {};
      const contactBodies = requiredBodies.filter((bodyId) => {
        const bodySamples = samples.filter((sample) => sampleMatchesBody(sample, bodyId));
        const ranked = bodySamples.map((sample) => ({
          pointMm: [...sample.pointMm],
          surfaceDistanceMm: pointObjectDistance(sample.pointMm, proxy),
        })).sort((a, b) => a.surfaceDistanceMm - b.surfaceDistanceMm);
        witnesses[bodyId] = { ...ranked[0], sampleCount: bodySamples.length };
        return ranked[0]?.surfaceDistanceMm <= toleranceMm;
      });
      return {
        ok: contactBodies.length === requiredBodies.length,
        schema: "robobuddy.sampled-pinch.v1",
        reasons: contactBodies.length === requiredBodies.length ? [] : ["both configured opposing finger samples must contact the apparatus"],
        requiredBodies,
        contactBodies,
        sampleCount: samples.length,
        toleranceMm,
        maxPenetrationMm,
        maxPenetrationMmObserved: 0,
        witnesses,
      };
    }
    const witnesses = {};
    for (const bodyId of requiredBodies) {
      const bodySamples = samples.filter((sample) => sampleMatchesBody(sample, bodyId));
      const ranked = bodySamples.map((sample) => ({
        pointMm: [...sample.pointMm],
        surfaceDistanceMm: pointObjectSurfaceDistance(sample.pointMm, proxy),
        penetrationMm: pointObjectPenetrationDepth(sample.pointMm, proxy),
      })).sort((a, b) => a.surfaceDistanceMm - b.surfaceDistanceMm);
      witnesses[bodyId] = {
        pointMm: ranked[0]?.pointMm || null,
        surfaceDistanceMm: ranked[0]?.surfaceDistanceMm ?? Number.POSITIVE_INFINITY,
        maxPenetrationMm: ranked.reduce((maximum, sample) => Math.max(maximum, sample.penetrationMm), 0),
        sampleCount: bodySamples.length,
      };
    }
    const maxPenetrationMmObserved = Math.max(0, ...Object.values(witnesses).map((witness) => witness.maxPenetrationMm));
    const contactBodies = requiredBodies.filter((bodyId) => (
      witnesses[bodyId].surfaceDistanceMm <= toleranceMm
      && witnesses[bodyId].maxPenetrationMm <= maxPenetrationMm + 1e-6
    ));
    const reasons = [];
    if (contactBodies.length !== requiredBodies.length) reasons.push("both configured opposing finger surfaces must contact the apparatus");
    if (maxPenetrationMmObserved > maxPenetrationMm + 1e-6) reasons.push("finger penetration exceeds the physical-world contact limit");
    return {
      ok: reasons.length === 0,
      schema: "robobuddy.surface-pinch.v1",
      reasons,
      requiredBodies,
      contactBodies,
      sampleCount: samples.length,
      toleranceMm,
      maxPenetrationMm,
      maxPenetrationMmObserved,
      witnesses,
    };
  }

  robotObjectCollisionReport(jointState, basePose) {
    const effectors = new Map(this.effectorStatesFor(jointState, basePose).map((effector) => [effector.id, effector]));
    const samples = sampleRenderedGeometry(this.model, jointState, { basePose });
    const collisions = [];
    for (const object of Object.values(this.runtimeState.objects).filter((item) => !item.attachedTo)) {
      const proxy = physicalObjectProxy(object);
      if (!proxy) continue;
      const allowedEffectors = object.compatibleEffectors || object.allowedEffectors || [];
      for (const sample of samples) {
        if (!pointInsideObject(sample.pointMm, proxy)) continue;
        const permittedContact = allowedEffectors.some((effectorId) => {
          const configuredContact = this.configuredGraspFor(object, effectorId)?.physicalContact;
          if (configuredContact?.schema === "robobuddy.opposed-pinch.v1") {
            if (![configuredContact.fixedBodyId, configuredContact.movingBodyId].some((bodyId) => sampleMatchesBody(sample, bodyId))) return false;
            const pose = objectWorldTransform(object);
            if (!pose) return false;
            const local = transformPoint(inverseTransform(pose), sample.pointMm);
            const inBand = [1, 2].every((axis) => Math.abs(local[axis] - Number(configuredContact.bandCenterLocalMm[axis])) <= Number(configuredContact.bandHalfExtentsMm[axis]) + 1e-6);
            const withinSurfaceTolerance = pointBoxSurfaceDistance(sample.pointMm, proxy) <= Number(configuredContact.maxPenetrationMm ?? 1) + 1e-6;
            // The opposed band is mandatory while acquiring the object. After a
            // support-validated release, an exact configured jaw mesh may remain
            // in tangential surface contact as it slides clear. Any deeper entry,
            // or contact by any other robot body, remains a collision fault.
            return withinSurfaceTolerance && (object.currentFrame !== object.initialFrame || inBand);
          }
          const effector = effectors.get(effectorId);
          const semanticFrameId = object.currentFrame || object.initialFrame;
          const gripFrameId = object.physicalRest?.poses?.[semanticFrameId]?.graspFrameId || semanticFrameId;
          const frame = this.definition.frames?.[gripFrameId];
          const tolerance = Number(frame?.tolerance?.positionMm ?? 18) + 2;
          const allowedBody = this.contactBodiesFor(object, effectorId).some((bodyId) => sampleMatchesBody(sample, bodyId));
          const maxPenetrationMm = Math.min(0.5, Number(object.physicalRest?.tolerance?.maxPenetrationMm ?? 0.5));
          return effector
            && frame?.role === "contact"
            && distance3(effector.positionMm, frame.positionMm) <= Math.max(80, tolerance)
            && allowedBody
            && (this.profileKey === "lekiwi" || pointObjectPenetrationDepth(sample.pointMm, proxy) <= maxPenetrationMm + 1e-6);
        });
        if (!permittedContact) collisions.push({ robotProxyId: sample.proxyId || sample.id, obstacleId: object.id, geometry: "robot-unattached-object-baked-renderer-sample", pointMm: [...sample.pointMm] });
      }
    }
    return { ok: collisions.length === 0, collisions };
  }

  updateFreeFallObjects(dt) {
    for (const object of Object.values(this.runtimeState.objects).filter((item) => item.releasedUnsupported && !item.attachedTo)) {
      const beforeProxy = physicalObjectProxy(object);
      if (!beforeProxy) continue;
      const velocity = Array.isArray(object.freeFallVelocityMmPerS) ? [...object.freeFallVelocityMmPerS] : [0, 0, 0];
      velocity[1] -= 9810 * dt;
      object.worldPositionMm = object.worldPositionMm.map((value, axis) => Number(value) + velocity[axis] * dt);
      object.freeFallVelocityMmPerS = velocity;
      const afterProxy = physicalObjectProxy(object);
      if (!afterProxy) continue;
      const beforeVerticalRadius = beforeProxy.axes.reduce((sum, axis, index) => sum + Math.abs(axis[1]) * beforeProxy.halfExtentsMm[index], 0);
      const afterVerticalRadius = afterProxy.axes.reduce((sum, axis, index) => sum + Math.abs(axis[1]) * afterProxy.halfExtentsMm[index], 0);
      const beforeBottomY = beforeProxy.centerMm[1] - beforeVerticalRadius;
      const afterBottomY = afterProxy.centerMm[1] - afterVerticalRadius;
      const surfaces = [...new Set(Object.values(object.physicalRest?.poses || {}).map((pose) => pose.surfaceId))]
        .map((surfaceId) => supportSurface(this.definition, surfaceId))
        .filter((surface) => surface?.type === "box")
        .sort((a, b) => b.topY - a.topY);
      const landed = surfaces.find((surface) => (
        beforeBottomY >= surface.topY - 1e-6
        && afterBottomY <= surface.topY
        && Math.abs(afterProxy.centerMm[0] - surface.centerMm[0]) <= surface.halfExtentsMm[0]
        && Math.abs(afterProxy.centerMm[2] - surface.centerMm[2]) <= surface.halfExtentsMm[2]
      ));
      if (landed) {
        object.worldPositionMm[1] += landed.topY - afterBottomY;
        object.freeFallVelocityMmPerS = [0, 0, 0];
        object.releasedUnsupported = false;
        object.currentFrame = "world_supported";
        this.event("UNSUPPORTED_OBJECT_LANDED", { objectId: object.id, surfaceId: landed.id, frameId: object.currentFrame, placementCredited: false });
      } else if (object.worldPositionMm[1] < -1000) {
        object.freeFallVelocityMmPerS = [0, 0, 0];
        object.releasedUnsupported = false;
        object.currentFrame = "world_fallen";
        this.event("UNSUPPORTED_OBJECT_LEFT_WORKCELL", { objectId: object.id, placementCredited: false });
      }
    }
  }

  applyStableSupportConstraint(candidate, candidateVelocity, proposedBase, payloadCollision) {
    if (!payloadCollision.collisions.length || payloadCollision.collisions.some((item) => item.geometry !== "payload-oriented-box")) return false;
    const constrained = [];
    const constrainedJointIds = new Set();
    for (const collision of payloadCollision.collisions) {
      const object = this.runtimeState.objects[collision.payloadId];
      if (!object?.attachedTo) return false;
      const currentPose = objectWorldTransform(object);
      const stable = Object.keys(object.physicalRest?.poses || {}).some((frameId) => (
        object.physicalRest.poses[frameId].surfaceId === collision.obstacleId
        && validateRestPose(this.definition, object, currentPose, frameId, {
          targetPositionToleranceMm: Number.POSITIVE_INFINITY,
          maxGapMm: Math.max(5, Number(object.physicalRest?.tolerance?.maxGapMm ?? 2)),
        }).ok
      ));
      if (!stable) return false;
      const chainId = this.profileKey === "openarm" ? object.attachedTo : Object.keys(this.model.chains)[0];
      const chainJoints = this.model.chains[chainId]?.joints?.flatMap((joint) => joint.jointId ? [joint.jointId] : []) || [];
      chainJoints.forEach((jointId) => constrainedJointIds.add(jointId));
      constrained.push(`${object.id}:${collision.obstacleId}`);
    }
    if (this.profileKey === "lekiwi") {
      proposedBase.rootPose = deepClone(this.runtimeState.rootPose);
      proposedBase.velocity = { x: 0, y: 0, thetaDeg: 0 };
    }
    // Resolve a hard support contact as a unilateral constraint at the fixed
    // 20 ms plant step. Admit only coupled-servo components that remain clear
    // of the robot, payload, and workcell; reject components that would press
    // a carrier corner through its support. This lets a commanded lift pull
    // away naturally without either penetrating or pinning the whole arm.
    const safe = deepClone(this.runtimeState.jointState);
    const safeVelocity = { ...this.jointVelocity };
    let admitted = 0;
    for (const jointId of constrainedJointIds) {
      const trial = { ...safe, [jointId]: candidate[jointId] };
      const robotClear = stateCollisionReport(this.model, trial, this.obstacles, {
        basePose: proposedBase.rootPose,
        contactSurfaceClearanceMm: Number(this.definition.coordination?.tableClearance?.contactSurfaceClearanceMm ?? 1),
      }).ok && this.robotObjectCollisionReport(trial, proposedBase.rootPose).ok;
      const payloadClear = this.payloadCollisionReport(trial, proposedBase.rootPose).ok;
      if (robotClear && payloadClear) {
        safe[jointId] = candidate[jointId];
        safeVelocity[jointId] = candidateVelocity[jointId];
        admitted += 1;
      } else {
        safeVelocity[jointId] = 0;
      }
    }
    constrainedJointIds.forEach((jointId) => {
      candidate[jointId] = safe[jointId];
      candidateVelocity[jointId] = safeVelocity[jointId];
    });
    constrained.forEach((key) => {
      if (this.supportContactConstraints.has(key)) return;
      this.supportContactConstraints.add(key);
      const [objectId, surfaceId] = key.split(":");
      this.event("STABLE_SUPPORT_CONTACT", { objectId, surfaceId, constraint: "nonpenetrating unilateral contact", admittedJointComponents: admitted });
    });
    return constrained.length > 0;
  }

  effectorStatesFor(jointState, basePose) {
    const state = this.runtimeState.jointState;
    const root = this.runtimeState.rootPose;
    this.runtimeState.jointState = jointState;
    this.runtimeState.rootPose = basePose;
    try { return this.effectorStates(); }
    finally {
      this.runtimeState.jointState = state;
      this.runtimeState.rootPose = root;
    }
  }

  updateVisitedFrames(effectors) {
    for (const [frameId, frame] of Object.entries(this.definition.frames || {})) {
      const tolerance = Number(frame.visitToleranceMm ?? frame.tolerance?.positionMm ?? 18);
      const matchedEffector = effectors.find((effector) => (!frame.chainId || frame.chainId === effector.id) && distance3(effector.positionMm, frame.positionMm) <= tolerance);
      const rootDistance = distance3(this.runtimeState.rootPose.positionMm, frame.positionMm);
      const baseFrame = this.profileKey === "lekiwi" && /base/i.test(frameId) && rootDistance <= tolerance;
      if (!matchedEffector && !baseFrame) continue;
      if (!this.runtimeState.visitedFrames.includes(frameId)) {
        this.runtimeState.visitedFrames.push(frameId);
        this.runtimeState.lastReachedFrame = frameId;
        this.event("FRAME_REACHED", { frameId, effector: matchedEffector?.id || "base" });
      }
    }
  }

  commitPhysicalProcesses() {
    for (const process of this.definition.processModels || []) {
      const state = this.runtimeState.processes[process.id];
      if (!state || state.state === process.completeState) continue;
      if (!(process.prerequisites || []).every((predicate) => evaluatePredicate(this.runtimeState, predicate))) continue;
      const physicalContactSatisfied = !process.contactFrame
        || this.runtimeState.visitedFrames.includes(process.contactFrame)
        || Object.values(this.runtimeState.objects).some((object) => object.currentFrame === process.contactFrame && !object.attachedTo);
      if (!physicalContactSatisfied) continue;
      this.event("PROCESS_CONTACT", { processId: process.id, fixtureId: process.fixtureId || "", frameId: process.contactFrame || "" });
      state.state = process.completeState;
      state.commits += 1;
      state.objectId = Object.values(this.runtimeState.objects).find((object) => object.currentFrame === process.contactFrame || object.currentFrame?.includes("destination") || object.currentFrame?.includes("handoff"))?.id || "";
      this.event("PROCESS_COMMIT", { processId: process.id, fixtureId: process.fixtureId || "", value: state.state, objectId: state.objectId });
    }
  }

  event(type, details = {}) {
    const entry = { sequence: this.runtimeState.eventLog.length + 1, type, clockSeconds: this.clockSeconds, ...deepClone(details) };
    this.runtimeState.eventLog.push(entry);
    return entry;
  }
}
