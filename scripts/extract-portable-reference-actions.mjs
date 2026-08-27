import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ScenarioV2Engine } from "../lab/v2/scenario-engine.js";
import { homeJointState, loadRobotModel } from "../lab/v2/robot-model-catalog.js";
import { so101ActionToJointState, so101JointStateToAction } from "../lab/v2/so101-command-model.js";
import { forwardKinematics, inverseKinematics } from "../lab/v2/kinematics.js";
import { planJointPath } from "../lab/v2/planner.js";
import { gripperContactWitnesses, stateCollisionReport } from "../lab/v2/collision.js";
import { composeTransform, dot3, inverseTransform, normalize3, rotate3, transformPoint, transposeRotation } from "../lab/v2/math.js";
import { assertScenarioV2, stripValidationForClient } from "../lab/v2/scenario-schema.js";
import { objectOriginForGrip } from "./portable-physical-rest-helpers.mjs";

const root = process.cwd();
const familyPaths = process.argv.includes("--openarm-only") ? ["openarm"]
  : process.argv.includes("--lekiwi-only") ? ["lekiwi"]
    : process.argv.includes("--so101-only") ? ["so101"]
    : ["so101", "lekiwi", "openarm"];
const scenarioFilter = process.argv.find((argument) => argument.startsWith("--scenario="))?.slice("--scenario=".length) || "";

function sources() {
  return familyPaths.flatMap((family) => fs.readdirSync(path.join(root, "missions/lab-assistant/v2/definitions", family))
    .filter((name) => name.endsWith(".json"))
    .filter((name) => !scenarioFilter || name === `${scenarioFilter}.json`)
    .map((name) => path.join(root, "missions/lab-assistant/v2/definitions", family, name)));
}

function legacyDefinition(relative, current) {
  const legacy = JSON.parse(execFileSync("git", ["show", `HEAD:${relative.replaceAll("\\", "/")}`], { cwd: root, encoding: "utf8" }));
  legacy.canonicalModel.sourceRevision = current.canonicalModel.sourceRevision;
  return legacy;
}

function referenceCallsForCurrentDefinition(current, legacy) {
  const legacyCalls = legacy.validation?.referenceExecutions?.[0]?.calls || [];
  const currentCalls = current.validation?.referenceExecutions?.[0]?.calls || [];
  if (!currentCalls.length && ["so101_follower", "openarm_v2_bimanual"].includes(current.robotId)) {
    let transportIndex = 0;
    return legacyCalls.map((call) => {
      if (call.method !== "skills.transport") return call;
      const grasp = current.grasps?.[transportIndex++];
      if (!grasp) throw new Error(`${current.id}: no current grasp exists for legacy transport ${transportIndex}.`);
      const objectId = grasp.objectId;
      const frame = (preferred, suffix, legacyFrame) => {
        if (preferred && current.frames?.[preferred]) return preferred;
        const derived = `${objectId}_${suffix}`;
        if (current.frames?.[derived]) return derived;
        if (legacyFrame && current.frames?.[legacyFrame]) return legacyFrame;
        throw new Error(`${current.id}/${objectId}: current ${suffix} frame is unavailable.`);
      };
      return {
        ...call,
        args: {
          ...(call.args || {}),
          objectId,
          effector: grasp.effector ?? call.args?.effector,
          approachFrame: frame(grasp.approachFrame, "approach", call.args?.approachFrame),
          contactFrame: frame(grasp.contactFrame, "contact", call.args?.contactFrame),
          liftFrame: frame(grasp.liftFrame, "lift", call.args?.liftFrame),
          destinationFrame: frame(grasp.destinationFrame, "destination", call.args?.destinationFrame),
          placeFrame: frame(grasp.placeFrame, "place_contact", call.args?.placeFrame || call.args?.destinationFrame),
          retreatFrame: frame(grasp.retreatFrame, "retreat", call.args?.retreatFrame),
        },
      };
    });
  }
  if (!currentCalls.length) return legacyCalls;
  // Portable missions generated before semantic validation calls existed can
  // legitimately acquire a new source-owned transport trace during a reviewed
  // mission redesign. In that case there is no legacy call sequence to merge;
  // use the current bounded calls verbatim and let the extractor re-solve every
  // waypoint against the current fixtures, IK limits, and collision model.
  if (!legacyCalls.length) return structuredClone(currentCalls);
  if (currentCalls.length !== legacyCalls.length) {
    throw new Error(`${current.id}: current and legacy reference call counts differ (${currentCalls.length} !== ${legacyCalls.length}).`);
  }
  return legacyCalls.map((legacyCall, index) => {
    const currentCall = currentCalls[index];
    if (currentCall.method !== legacyCall.method) {
      throw new Error(`${current.id}: reference call ${index} changed method (${legacyCall.method} -> ${currentCall.method}).`);
    }
    // The legacy trace supplies the reviewed operation sequence only. Object,
    // frame, and fixture identifiers must come from the current owning source;
    // otherwise apparatus migrations replay removed carrier-era identifiers.
    return { ...legacyCall, args: structuredClone(currentCall.args ?? legacyCall.args ?? {}) };
  });
}

function round(value, places = 6) { return Number(Number(value).toFixed(places)); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function soActions(records) {
  const actions = [];
  for (const record of records) {
    const compiled = record.sample.compiledAction;
    if (!compiled?.action && !record.state?.jointState) continue;
    const publicState = so101JointStateToAction(record.state.jointState);
    const action = Object.fromEntries(Object.entries(publicState).map(([key, value]) => [key, round(value)]));
    if (same(actions.at(-1)?.action, action)) continue;
    const phase = compiled?.phase || record.sample.phase || "joint_path";
    // The public send_action contract updates the target immediately, while
    // the fixed-step plant remains velocity/acceleration limited.  Give each
    // collision-checked SO-101 waypoint enough simulated time to settle before
    // issuing the next target; 0.2 s accumulated tracking lag and made an
    // otherwise vertical lift scrape the pickup work surface during transfer.
    actions.push({ label: phase, action, hold_seconds: phase.includes("close") || phase.includes("open_then") ? 0.9 : 0.5 });
  }
  return actions;
}

function openArmPublic(joints) {
  const action = {};
  for (const side of ["left", "right"]) {
    for (let index = 1; index <= 7; index += 1) action[`${side}_joint_${index}.pos`] = round(joints[`${side}_j${index}`]);
    action[`${side}_gripper.pos`] = -65;
  }
  return action;
}

function segmentRecords(records) {
  const output = [];
  for (const record of records) {
    const previous = output.at(-1);
    if (!previous || previous.sample.phase !== record.sample.phase || previous.callIndex !== record.callIndex) output.push(record);
    else output[output.length - 1] = record;
  }
  return output;
}

function openArmActions(records) {
  const actions = [];
  for (const record of segmentRecords(records.filter((item) => item.sample.phase !== "base_transfer"))) {
    const phase = record.sample.phase || "joint_target";
    const action = openArmPublic(record.state.jointState);
    const event = (record.sample.events || []).find((item) => ["ATTACH_OBJECT", "DETACH_OBJECT"].includes(item.type));
    const active = event?.effector || (phase.includes("left") ? "left" : phase.includes("right") ? "right" : record.callArgs?.effector);
    if (phase === "contact" && active) {
      action[`${active}_gripper.pos`] = -65;
      actions.push({ label: `${active} contact approach`, action: { ...action }, hold_seconds: 1 });
      action[`${active}_gripper.pos`] = 0;
      actions.push({ label: `${active} close after FK contact`, action: { ...action }, hold_seconds: 0.8 });
      continue;
    }
    if (phase === "place" && active) {
      action[`${active}_gripper.pos`] = 0;
      actions.push({ label: `${active} placement contact`, action: { ...action }, hold_seconds: 1 });
      action[`${active}_gripper.pos`] = -65;
      actions.push({ label: `${active} release at live tool pose`, action: { ...action }, hold_seconds: 0.8 });
      continue;
    }
    if (active && ["lift", "transfer"].includes(phase)) action[`${active}_gripper.pos`] = 0;
    actions.push({ label: `${active || "bimanual"} ${phase}`, action, hold_seconds: 1 });
  }
  return actions.filter((item, index) => index === 0 || !same(item.action, actions[index - 1].action));
}

const openArmLimits = {
  left: { j1: [-75, 75], j2: [-90, 9], j3: [-85, 85], j4: [0, 135], j5: [-85, 85], j6: [-40, 40], j7: [-80, 80] },
  right: { j1: [-75, 75], j2: [-9, 90], j3: [-85, 85], j4: [0, 135], j5: [-85, 85], j6: [-40, 40], j7: [-80, 80] },
};

async function openArmPhysicalActions(current, legacy) {
  const model = await loadRobotModel(current.robotId);
  let state = homeJointState(model);
  state.left_gripper = 45;
  state.right_gripper = 45;
  const actions = [];
  const collisionOptions = {
    basePose: { positionMm: [0, 0, 0], headingDeg: 0 },
    contactSurfaceClearanceMm: Number(current.coordination?.tableClearance?.contactSurfaceClearanceMm ?? 1),
  };
  const calls = referenceCallsForCurrentDefinition(current, legacy)
    .filter((call) => call.method === "skills.transport");
  for (const call of calls) {
    const args = call.args || {};
    const side = args.effector === "right" ? "right" : "left";
    const handledObject = current.objects.find((item) => item.id === args.objectId);
    const toolDirectionConstraint = handledObject
      ? {
        // The gripper's local Z axis is the finger-separation direction. Keep
        // it horizontal across the directly handled apparatus so the open jaws
        // straddle the body/rim instead of putting one finger through the real
        // support surface beneath it.
        localVector: [0, 0, 1],
        targetVector: [0, 0, 1],
        toleranceDeg: 3,
        weightMmPerRad: 220,
      }
      : null;
    const obstacles = current.fixtures.flatMap((fixture) => (fixture.collisionProxies || (fixture.collisionProxy ? [fixture.collisionProxy] : []))
      // Contact surfaces remain solid to the robot.  Only a declared robot
      // mount contact may overlap the canonical robot without faulting.
      .filter((proxy) => proxy.planningRole !== "robot_mount_contact")
      .map((proxy, index) => ({ id: `${fixture.id}:${proxy.id || index}`, ...proxy })));
    const sequence = [
      ["approach", args.approachFrame, -65], ["contact approach", args.contactFrame, -65],
      ["close after FK contact", args.contactFrame, 0], ["lift", args.liftFrame, 0],
      ["transfer", args.destinationFrame, 0], ["placement contact", args.placeFrame || args.destinationFrame, 0],
      ["release at live tool pose", args.placeFrame || args.destinationFrame, -65], ["retreat", args.retreatFrame, -65],
    ];
    let lastFrame = "";
    let payloadDirection = null;
    let lastRejectedCollision = null;
    let lastRejectedRobotProxy = null;
    let lastMotionRouteFailure = null;
    const transitionClear = (candidate, initial = state) => {
      const sample = { ...initial };
      const velocity = Object.fromEntries(model.joints.map((joint) => [joint.id, 0]));
      for (let tick = 0; tick < 300; tick += 1) {
        let settled = true;
        for (const joint of model.joints) {
          const target = Number(candidate[joint.id]);
          const currentPosition = Number(sample[joint.id]);
          const difference = target - currentPosition;
          if (Math.abs(difference) <= 1e-9) { sample[joint.id] = target; velocity[joint.id] = 0; continue; }
          settled = false;
          const direction = Math.sign(difference);
          const brakingVelocity = Math.sqrt(Math.max(0, 2 * 480 * Math.abs(difference)));
          const desiredVelocity = direction * Math.min(120, brakingVelocity);
          velocity[joint.id] += Math.max(-9.6, Math.min(9.6, desiredVelocity - velocity[joint.id]));
          const step = velocity[joint.id] * 0.02;
          if (Math.sign(target - (currentPosition + step)) !== direction || Math.abs(step) >= Math.abs(difference)) { sample[joint.id] = target; velocity[joint.id] = 0; }
          else sample[joint.id] = currentPosition + step;
        }
        const collision = stateCollisionReport(model, sample, obstacles, collisionOptions);
        if (!collision.ok) {
          lastRejectedCollision = collision.collisions[0] || null;
          lastRejectedRobotProxy = collision.proxies.find((proxy) => proxy.id === lastRejectedCollision?.robotProxyId) || null;
          return null;
        }
        if (payloadDirection) {
          const rotation = forwardKinematics(model, sample, { chainId: side }).transform.rotation;
          const aligned = [
            [payloadDirection.localVector, payloadDirection.targetVector],
            [payloadDirection.secondaryLocalVector, payloadDirection.secondaryTargetVector],
          ].filter(([local, target]) => local && target).every(([local, target]) => {
            const current = normalize3(rotate3(rotation, local));
            const angleDeg = Math.acos(Math.max(-1, Math.min(1, dot3(current, target)))) * 180 / Math.PI;
            return angleDeg <= payloadDirection.toleranceDeg + 0.05;
          });
          if (!aligned) return null;
        }
        if (settled) return { state: sample, holdSeconds: Number(((tick + 1) * 0.02).toFixed(2)) };
      }
      return null;
    };
    const sidePlanningModel = {
      ...model,
      chains: {
        ...model.chains,
        [side]: {
          ...model.chains[side],
          joints: model.chains[side].joints.filter((joint) => joint.jointId !== "base_yaw"),
        },
      },
    };
    const payloadDirectionClear = (sample) => {
      if (!payloadDirection) return true;
      const rotation = forwardKinematics(model, sample, { chainId: side }).transform.rotation;
      return [
        [payloadDirection.localVector, payloadDirection.targetVector],
        [payloadDirection.secondaryLocalVector, payloadDirection.secondaryTargetVector],
      ].filter(([local, target]) => local && target).every(([local, target]) => {
        const current = normalize3(rotate3(rotation, local));
        const angleDeg = Math.acos(Math.max(-1, Math.min(1, dot3(current, target)))) * 180 / Math.PI;
        return angleDeg <= payloadDirection.toleranceDeg + 0.05;
      });
    };
    const motionRoute = (candidate, initial, seed) => {
      const direct = transitionClear(candidate, initial);
      if (direct) return { states: [{ state: candidate, holdSeconds: direct.holdSeconds }], code: "DIRECT_FIXED_STEP" };
      const planned = planJointPath(sidePlanningModel, initial, candidate, obstacles, {
        chainId: side,
        fixedJointState: initial,
        basePose: { positionMm: [0, 0, 0], headingDeg: 0 },
        maxStepDeg: 2,
        collisionStepDeg: 2,
        rrtStepDeg: 8,
        maxIterations: 4000,
        seed,
        acceptState: payloadDirectionClear,
        constraintFailureCode: "PAYLOAD_TILT",
      });
      if (!planned.ok) {
        lastMotionRouteFailure = { code: planned.code, directFailure: planned.directFailure, iterations: planned.iterations };
        return null;
      }
      const states = [];
      let cursor = initial;
      for (const sample of planned.path.slice(1)) {
        const full = { ...initial, ...sample, [`${side}_gripper`]: candidate[`${side}_gripper`] };
        const transition = transitionClear(full, cursor);
        if (!transition) {
          lastMotionRouteFailure = { code: "FIXED_STEP_ROUTE_COLLISION", plannedCode: planned.code, routeIndex: states.length + 1, routeLength: planned.path.length };
          return null;
        }
        states.push({ state: full, holdSeconds: Math.max(0.12, transition.holdSeconds) });
        cursor = full;
      }
      return states.length ? { states, code: planned.code } : null;
    };
    const solvePoint = (targetMm, gripper, toleranceMm, label, initialState = state) => {
      let solved = null;
      let solvedMotion = null;
      const profiles = toolDirectionConstraint
        ? [[1, 2, 3, 4, 5, 6, 7]]
        : [[1, 2, 3, 4, 6], [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6, 7]];
      for (let profileIndex = 0; profileIndex < profiles.length && !solved?.ok; profileIndex += 1) {
        const active = profiles[profileIndex].map((joint) => `${side}_j${joint}`);
        const candidate = inverseKinematics(model, targetMm, {
          chainId: side, initialJointState: initialState, activeJoints: active, seed: 700 + actions.length + profileIndex * 1009,
          starts: payloadDirection ? (handledObject?.visual?.type === "watch_glass" ? 48 : 12) : toolDirectionConstraint ? 128 : profileIndex === 0 ? 64 : profileIndex === 1 ? 192 : 512, maxIterations: 1000, toleranceMm,
          // Candidate seeds always start with the current state and then the
          // active-joint home. The first collision-clear accepted solution is
          // therefore the least gratuitous local branch for dense Cartesian
          // waypoints; continuing hundreds of random starts only changes the
          // posture while multiplying generation time.
          stopOnFirstAccepted: Boolean(toolDirectionConstraint ? !payloadDirection : payloadDirection),
          acceptJointState: (jointState) => {
            if (!Object.entries(openArmLimits[side]).every(([joint, [minimum, maximum]]) => Number(jointState[`${side}_${joint}`]) >= minimum && Number(jointState[`${side}_${joint}`]) <= maximum)) return false;
            const candidateState = { ...initialState, ...jointState, [`${side}_gripper`]: -gripper * 45 / 65 };
            const collision = stateCollisionReport(model, candidateState, obstacles, collisionOptions);
            if (!collision.ok || !payloadDirectionClear(candidateState)) return false;
            return label !== "placement contact" || Boolean(transitionClear({ ...candidateState, [`${side}_gripper`]: 45 }, candidateState));
          },
          scoreJointState: (jointState) => active.reduce((sum, joint) => sum + Math.abs(Number(jointState[joint]) - Number(initialState[joint])), 0) + 2 * Math.abs(Number(jointState[`${side}_j5`]) - Number(initialState[`${side}_j5`])) + 2 * Math.abs(Number(jointState[`${side}_j7`]) - Number(initialState[`${side}_j7`])),
          directionConstraint: payloadDirection || toolDirectionConstraint,
        });
        if (candidate.ok) {
          const candidateState = { ...initialState, ...candidate.jointState, [`${side}_gripper`]: -gripper * 45 / 65 };
          const motion = motionRoute(candidateState, initialState, 1901 + actions.length * 41 + profileIndex * 1009);
          if (motion) { solved = candidate; solvedMotion = motion; }
        }
      }
      if (!solved?.ok) return null;
      const candidateState = { ...initialState, ...solved.jointState, [`${side}_gripper`]: -gripper * 45 / 65 };
      const finalStep = solvedMotion.states.at(-1);
      return { state: candidateState, holdSeconds: finalStep.holdSeconds, jointPath: solvedMotion.states, routeCode: solvedMotion.code };
    };
    for (const [label, frameId, gripper] of sequence) {
      if (scenarioFilter) console.log(`${current.id}/${side}: solving ${label} at ${frameId}`);
      if (frameId !== lastFrame) {
        const frame = current.frames[frameId];
        if (!frame) throw new Error(`${current.id}: missing OpenArm frame ${frameId}.`);
        const finalToleranceMm = Number(frame.tolerance?.positionMm || 3);
        // Once an apparatus is attached, preserve its gravity alignment along
        // the entire route with <=10 mm Cartesian waypoints. A single distant
        // endpoint can be clear while independent servo acceleration tilts the
        // payload or sweeps it through the workcell between endpoints.
        // Contact and placement must follow the declared Cartesian approach;
        // accepting a collision-free endpoint joined by an unconstrained RRT
        // can sweep an open finger through the still-resting apparatus.
        const requiresConfiguredApproach = label === "approach"
          && (side === "right" || handledObject?.visual?.type !== "watch_glass");
        const direct = (payloadDirection || ["contact approach", "placement contact"].includes(label) || requiresConfiguredApproach)
          ? null
          : solvePoint(frame.positionMm, gripper, finalToleranceMm, label, state);
        let solvedRoute = direct ? [{ point: frame.positionMm, ...direct }] : null;
        if (!solvedRoute && (payloadDirection || ["contact approach", "placement contact"].includes(label))) {
          const start = forwardKinematics(model, state, { chainId: side }).positionMm;
          const distance = Math.hypot(...frame.positionMm.map((value, axis) => value - start[axis]));
          const count = Math.max(1, Math.ceil(distance / 10));
          let routeState = state;
          const routeResults = [];
          for (let index = 1; index <= count; index += 1) {
            const point = start.map((value, axis) => value + (frame.positionMm[axis] - value) * index / count);
            const solved = solvePoint(point, gripper, index === count ? finalToleranceMm : Math.max(3, finalToleranceMm), label, routeState);
            if (!solved) { routeResults.length = 0; break; }
            routeState = solved.state;
            routeResults.push({ point, ...solved });
          }
          if (routeResults.length) solvedRoute = routeResults;
        }
        if (!solvedRoute && ["approach", "transfer"].includes(label)) {
          const transitY = Number(current.coordination?.tableClearance?.transitToolCenterY);
          if (!Number.isFinite(transitY)) throw new Error(`${current.id}/${frameId}: source-owned transitToolCenterY is unavailable.`);
          const start = forwardKinematics(model, state, { chainId: side }).positionMm;
          const route = [
            [start[0], Math.max(transitY, start[1]), start[2]],
            [frame.positionMm[0], Math.max(transitY, frame.positionMm[1]), frame.positionMm[2]],
            frame.positionMm
          ].filter((point, index, points) => index === 0 || Math.hypot(...point.map((value, axis) => value - points[index - 1][axis])) > 1);
          let routeState = state;
          const routeResults = [];
          for (let index = 0; index < route.length; index += 1) {
            const final = index === route.length - 1;
            const solved = solvePoint(route[index], gripper, final ? finalToleranceMm : Math.max(4, Math.min(finalToleranceMm, 8)), label, routeState);
            if (!solved) { routeResults.length = 0; break; }
            routeState = solved.state;
            routeResults.push({ point: route[index], ...solved });
          }
          if (routeResults.length) solvedRoute = routeResults;
        }
        if (!solvedRoute) throw new Error(`${current.id}/${frameId}: no collision-clear direct or configured-transit route was found. Last collision: ${JSON.stringify(lastRejectedCollision)}. Last motion-route failure: ${JSON.stringify(lastMotionRouteFailure)}.`);
        if (scenarioFilter) console.log(`${current.id}/${side}: accepted ${label} with ${solvedRoute.length} Cartesian segment(s)`);
        for (let index = 0; index < solvedRoute.length; index += 1) {
          const solved = solvedRoute[index];
          const final = index === solvedRoute.length - 1;
          for (let routeIndex = 0; routeIndex < solved.jointPath.length; routeIndex += 1) {
            const routeStep = solved.jointPath[routeIndex];
            const finalRouteStep = routeIndex === solved.jointPath.length - 1;
            state = routeStep.state;
            const action = openArmPublic(state);
            action[`${side}_gripper.pos`] = gripper;
            actions.push({
              label: final && finalRouteStep ? `${side} ${label}` : `${side} collision-clear ${solved.routeCode.toLowerCase()} ${routeIndex + 1}/${solved.jointPath.length}`,
              action,
              hold_seconds: Math.max(0.12, routeStep.holdSeconds),
            });
          }
        }
        lastFrame = frameId;
        if (label === "contact approach") {
          const rotation = forwardKinematics(model, state, { chainId: side }).transform.rotation;
          payloadDirection = {
            localVector: rotate3(transposeRotation(rotation), [0, 1, 0]),
            targetVector: [0, 1, 0],
            toleranceDeg: 2,
            weightMmPerRad: 180,
          };
        }
        continue;
      }
      const candidate = { ...state, [`${side}_gripper`]: -gripper * 45 / 65 };
      const transition = transitionClear(candidate);
      if (!transition) throw new Error(`${current.id}/${frameId}: ${label} gripper transition intersects the configured workcell at ${JSON.stringify(lastRejectedCollision)}; robot proxy ${JSON.stringify(lastRejectedRobotProxy)}.`);
      const action = openArmPublic(state);
      action[`${side}_gripper.pos`] = gripper;
      actions.push({ label: `${side} ${label}`, action, hold_seconds: Math.max(0.12, transition.holdSeconds) });
      state = candidate;
      if (label === "release at live tool pose") payloadDirection = null;
    }
  }
  return actions;
}

function lekiwiArmAction(joints, gripper) {
  return {
    "arm_shoulder_pan.pos": round(joints.shoulder_pan), "arm_shoulder_lift.pos": round(joints.shoulder_lift),
    "arm_elbow_flex.pos": round(joints.elbow_flex), "arm_wrist_flex.pos": round(joints.wrist_flex),
    "arm_wrist_roll.pos": round(joints.wrist_roll), "arm_gripper.pos": gripper,
    "x.vel": 0, "y.vel": 0, "theta.vel": 0,
  };
}

function boundaryRoute(startPose, endPose) {
  const start = { x: startPose.positionMm[0], z: startPose.positionMm[2], heading: startPose.headingDeg };
  const end = { x: endPose.positionMm[0], z: endPose.positionMm[2], heading: endPose.headingDeg };
  const corners = end.x === 0 && end.z === 0
    ? [{ x: 700, z: start.z }, { x: 700, z: 0 }, { x: 0, z: 0 }]
    : [{ x: 700, z: start.z }, { x: 700, z: end.z }, { x: end.x, z: end.z }];
  const route = [{ positionMm: [start.x, 0, start.z], headingDeg: start.heading }];
  for (const corner of corners) {
    let current = route.at(-1);
    while (Math.abs(corner.x - current.positionMm[0]) > 1e-9 || Math.abs(corner.z - current.positionMm[2]) > 1e-9) {
      const dx = Math.max(-50, Math.min(50, corner.x - current.positionMm[0]));
      const dz = dx === 0 ? Math.max(-50, Math.min(50, corner.z - current.positionMm[2])) : 0;
      current = { positionMm: [current.positionMm[0] + dx, 0, current.positionMm[2] + dz], headingDeg: end.heading };
      route.push(current);
    }
  }
  return route;
}

function lekiwiActions(records) {
  const actions = [];
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    if (record.sample.phase === "base_transfer") {
      const baseRecords = [];
      while (index < records.length && records[index].sample.phase === "base_transfer" && records[index].callIndex === record.callIndex) baseRecords.push(records[index++]);
      actions.push({ label: "explicit stow before drive", action: lekiwiArmAction(baseRecords[0].state.jointState, 20), hold_seconds: 1 });
      const route = boundaryRoute(baseRecords[0].state.rootPose, baseRecords.at(-1).state.rootPose);
      for (let routeIndex = 1; routeIndex < route.length; routeIndex += 1) {
        const previous = route[routeIndex - 1];
        const rootPose = route[routeIndex];
        const dx = rootPose.positionMm[0] - previous.positionMm[0];
        const worldY = -(rootPose.positionMm[2] - previous.positionMm[2]);
        const dTheta = rootPose.headingDeg - previous.headingDeg;
        if (Math.abs(dx) + Math.abs(worldY) + Math.abs(dTheta) <= 1e-9) continue;
        const linearDistanceMetres = Math.hypot(dx, worldY) / 1000;
        const hold = 0.26;
        const heading = previous.headingDeg * Math.PI / 180;
        // The 20 ms plant executes a 0.26 s drive command followed by the
        // explicit 0.26 s stop below. For each 50 mm route segment,
        // distance/hold (0.192307... m/s) integrates to the configured stop
        // without the 0.08 mm-per-segment drift of the old rounded constant.
        const calibratedPeak = linearDistanceMetres > 0 ? linearDistanceMetres / hold : 0;
        const worldXVelocity = linearDistanceMetres > 0 ? calibratedPeak * (dx / 1000) / linearDistanceMetres : 0;
        const worldYVelocity = linearDistanceMetres > 0 ? calibratedPeak * worldY / 1000 / linearDistanceMetres : 0;
        const action = lekiwiArmAction(baseRecords.at(-1).state.jointState, 20);
        action["x.vel"] = round(worldXVelocity * Math.cos(heading) + worldYVelocity * Math.sin(heading));
        action["y.vel"] = round(-worldXVelocity * Math.sin(heading) + worldYVelocity * Math.cos(heading));
        action["theta.vel"] = round(dTheta / hold);
        actions.push({ label: "visible configured base-route segment", action, hold_seconds: hold });
        actions.push({ label: "explicit base stop between route segments", action: lekiwiArmAction(baseRecords.at(-1).state.jointState, 20), hold_seconds: hold });
      }
      actions.push({ label: "explicit base stop", action: lekiwiArmAction(baseRecords.at(-1).state.jointState, 20), hold_seconds: 0.1 });
      continue;
    }
    const phaseRecords = [record];
    index += 1;
    while (index < records.length && records[index].sample.phase === record.sample.phase && records[index].callIndex === record.callIndex) phaseRecords.push(records[index++]);
    const recordForPhase = phaseRecords.at(-1);
    const phase = recordForPhase.sample.phase || "arm_target";
    const closed = ["lift", "transfer", "place"].includes(phase);
    const appendDenseArmPath = (recordsForPath, label, gripper) => {
      for (const pathRecord of recordsForPath) {
        const action = lekiwiArmAction(pathRecord.state.jointState, gripper);
        if (same(actions.at(-1)?.action, action)) continue;
        // Match the fixed-step joint response: advancing these dense targets at
        // 0.2 s can leave the physical gripper behind the collision-checked
        // retreat path even though every authored waypoint is clear.
        actions.push({ label, action, hold_seconds: 0.3 });
      }
    };
    if (phase === "contact") {
      appendDenseArmPath(phaseRecords.slice(0, -1), "contact approach path", 20);
      actions.push({ label: "arm contact approach", action: lekiwiArmAction(recordForPhase.state.jointState, 20), hold_seconds: 0.3 });
      actions.push({ label: "close after FK contact", action: lekiwiArmAction(recordForPhase.state.jointState, 85), hold_seconds: 0.9 });
    } else if (phase === "place") {
      appendDenseArmPath(phaseRecords.slice(0, -1), "placement descent path", 85);
      actions.push({ label: "placement contact", action: lekiwiArmAction(recordForPhase.state.jointState, 85), hold_seconds: 0.3 });
      actions.push({ label: "release at live tool pose", action: lekiwiArmAction(recordForPhase.state.jointState, 20), hold_seconds: 0.9 });
    } else {
      appendDenseArmPath(phaseRecords, `${phase} path`, closed ? 85 : 20);
      if (actions.at(-1)) actions.at(-1).hold_seconds = Math.max(actions.at(-1).hold_seconds, 0.3);
    }
  }
  actions.push({ label: "explicit final stow", action: lekiwiArmAction({ shoulder_pan: 0, shoulder_lift: 0, elbow_flex: 0, wrist_flex: 0, wrist_roll: 0 }, 20), hold_seconds: 1 });
  return actions;
}

const openArmActionCache = new Map();

function levelYawRotation(rotation) {
  const yaw = Math.atan2(Number(rotation[2]), Number(rotation[0]));
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  return [cosine, 0, sine, 0, 1, 0, -sine, 0, cosine];
}

function horizontalFootprintHalfExtents(rotation, geometryHalfExtentsMm, marginMm = 10) {
  const hx = Number(geometryHalfExtentsMm[0]);
  const hz = Number(geometryHalfExtentsMm[2]);
  return [
    Math.abs(Number(rotation[0])) * hx + Math.abs(Number(rotation[2])) * hz + marginMm,
    Math.abs(Number(rotation[6])) * hx + Math.abs(Number(rotation[8])) * hz + marginMm,
  ];
}

async function calibrateStableRestFromReference(definition, actions) {
  if (!["so101_follower", "lekiwi_sim", "openarm_v2_bimanual"].includes(definition.robotId)) return;
  const model = await loadRobotModel(definition.robotId);
  const transported = definition.objects.filter((item) => item.transportable !== false);
  if (definition.robotId === "openarm_v2_bimanual") {
    const actionState = (action) => {
      const state = homeJointState(model);
      for (const side of ["left", "right"]) {
        for (let index = 1; index <= 7; index += 1) state[`${side}_j${index}`] = Number(action[`${side}_joint_${index}.pos`]);
        state[`${side}_gripper`] = -Number(action[`${side}_gripper.pos`]) * 45 / 65;
      }
      return state;
    };
    for (const object of transported) {
      const side = (object.allowedEffectors || object.compatibleEffectors || [])[0];
      const contact = actions.find((step) => step.label === `${side} contact approach`);
      const placement = actions.find((step) => step.label === `${side} placement contact`);
      if (!side || !contact || !placement) throw new Error(`${definition.id}/${object.id}: OpenArm reference-rest calibration is missing ${side || "configured"} contact or placement actions.`);
      const initial = object.physicalRest.poses[object.initialFrame];
      const finalFrameId = Object.keys(object.physicalRest.poses).find((frameId) => frameId !== object.initialFrame);
      const final = object.physicalRest.poses[finalFrameId];
      const basePose = { positionMm: [0, 0, 0], headingDeg: 0 };
      const contactTool = forwardKinematics(model, actionState(contact.action), { chainId: side, basePose }).transform;
      const placeTool = forwardKinematics(model, actionState(placement.action), { chainId: side, basePose }).transform;
      const attachment = composeTransform(inverseTransform(contactTool), { position: initial.positionMm, rotation: initial.rotationMatrix });
      const predicted = composeTransform(placeTool, attachment);
      const predictedGrip = composeTransform(predicted, { position: object.physicalRest.gripSocketMm, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).position;
      definition.frames[final.graspFrameId].positionMm = predictedGrip.map((value) => round(value, 6));
      final.positionMm = predicted.position.map((value) => round(value, 6));
      final.rotationMatrix = predicted.rotation.map((value) => round(value, 9));
      object.physicalRest.referenceCalibration = {
        source: "generated collision-checked official-action contact and live placement transforms",
        finalYawDeg: round(Math.atan2(predicted.rotation[2], predicted.rotation[0]) * 180 / Math.PI, 3),
        levelNormal: [0, 1, 0],
        physicalHardwareValidated: false,
      };
    }
    return;
  }
  const contacts = actions.filter((step) => step.label === (definition.robotId === "so101_follower" ? "close_after_contact" : "arm contact approach"));
  const placements = actions.filter((step) => step.label === (definition.robotId === "so101_follower" ? "place_contact" : "placement contact"));
  if (contacts.length !== transported.length || placements.length !== transported.length) {
    throw new Error(`${definition.id}: reference-rest calibration expected ${transported.length} contact/place pairs, found ${contacts.length}/${placements.length}.`);
  }
  const basePose = definition.robotId === "lekiwi_sim"
    ? { positionMm: [...definition.frames.service_base.basePositionMm], headingDeg: 0 }
    : { positionMm: [0, 0, 0], headingDeg: 0 };
  const actionState = (action) => definition.robotId === "so101_follower"
    ? { ...homeJointState(model), ...so101ActionToJointState(action) }
    : {
      ...homeJointState(model),
      shoulder_pan: Number(action["arm_shoulder_pan.pos"]),
      shoulder_lift: Number(action["arm_shoulder_lift.pos"]),
      elbow_flex: Number(action["arm_elbow_flex.pos"]),
      wrist_flex: Number(action["arm_wrist_flex.pos"]),
      wrist_roll: Number(action["arm_wrist_roll.pos"]),
      gripper: Number(action["arm_gripper.pos"]),
    };
  transported.forEach((object, index) => {
    const initial = object.physicalRest.poses[object.initialFrame];
    const finalFrameId = Object.keys(object.physicalRest.poses).find((frameId) => frameId !== object.initialFrame);
    const final = object.physicalRest.poses[finalFrameId];
    const contactTool = forwardKinematics(model, actionState(contacts[index].action), { chainId: "default", basePose }).transform;
    const placeTool = forwardKinematics(model, actionState(placements[index].action), { chainId: "default", basePose }).transform;
    if (definition.robotId === "so101_follower") {
      const grasp = definition.grasps.find((item) => item.objectId === object.id);
      const physicalContact = grasp?.physicalContact;
      const witnesses = gripperContactWitnesses(model, actionState(contacts[index].action), { basePose });
      if (!physicalContact || !witnesses) throw new Error(`${definition.id}/${object.id}: SO-101 contact calibration requires opposed-pinch metadata and baked witnesses.`);
      const initialTransform = { position: initial.positionMm, rotation: initial.rotationMatrix };
      const fixedLocal = transformPoint(inverseTransform(initialTransform), witnesses.fixed.pointMm);
      const contactHalfX = Number(physicalContact.contactHalfExtentMm);
      const contactCenterX = Number(physicalContact.bandCenterLocalMm[0]);
      const fixedFace = contactCenterX + Number(physicalContact.fixedFaceSign) * contactHalfX;
      const socketCorrectionMm = fixedFace - fixedLocal[0];
      object.physicalRest.gripSocketMm[0] += socketCorrectionMm;
      object.visual.gripSocketMm[0] = object.physicalRest.gripSocketMm[0];
      initial.positionMm = objectOriginForGrip(definition.frames[initial.graspFrameId].positionMm, initial.rotationMatrix, object.physicalRest.gripSocketMm);
      const pickupFixture = definition.fixtures.find((fixture) => (fixture.collisionProxies || []).some((proxy) => proxy.id === initial.surfaceId));
      const pickupSurface = pickupFixture?.collisionProxies?.find((proxy) => proxy.id === initial.surfaceId);
      if (!pickupSurface) throw new Error(`${definition.id}/${object.id}: calibrated pickup surface ${initial.surfaceId} is unavailable.`);
      pickupSurface.centerMm = [initial.positionMm[0], pickupSurface.centerMm[1], initial.positionMm[2]];
      object.physicalRest.referenceContactCalibration = {
        source: "generated contact tool transform plus baked fixed-jaw first-contact witness",
        gripSocketCorrectionMm: round(socketCorrectionMm, 6),
        maximumFacePenetrationMm: Number(physicalContact.maxPenetrationMm),
        physicalHardwareValidated: false,
      };
    }
    const attachment = composeTransform(inverseTransform(contactTool), { position: initial.positionMm, rotation: initial.rotationMatrix });
    const predicted = composeTransform(placeTool, attachment);
    const rotation = levelYawRotation(predicted.rotation);
    final.rotationMatrix = rotation;
    final.positionMm = objectOriginForGrip(definition.frames[final.graspFrameId].positionMm, rotation, object.physicalRest.gripSocketMm);
    if (definition.robotId === "so101_follower") {
      const destinationFixture = definition.fixtures.find((fixture) =>
        (fixture.collisionProxies || []).some((proxy) => proxy.id === final.surfaceId));
      const surface = destinationFixture?.collisionProxies?.find((proxy) => proxy.id === final.surfaceId);
      if (!surface) throw new Error(`${definition.id}/${object.id}: calibrated receiving surface ${final.surfaceId} is unavailable.`);
      const [halfX, halfZ] = horizontalFootprintHalfExtents(rotation, object.physicalRest.geometry.halfExtentsMm);
      surface.centerMm = [final.positionMm[0], surface.centerMm[1], final.positionMm[2]];
      const supportHalfX = Math.max(Number(surface.halfExtentsMm[0]), halfX + 2);
      const supportHalfZ = Math.max(Number(surface.halfExtentsMm[2]), halfZ + 2);
      surface.halfExtentsMm = [round(supportHalfX, 3), surface.halfExtentsMm[1], round(supportHalfZ, 3)];
      surface.provenance = `C: reference-calibrated broad receiving work-surface footprint (${round(supportHalfX * 2, 1)} x ${round(supportHalfZ * 2, 1)} mm) centered beneath the complete level directly handled apparatus at release; no post, pin, or pedestal`;
    }
    object.physicalRest.referenceCalibration = {
      source: "generated collision-checked reference contact and placement tool transforms",
      finalYawDeg: round(Math.atan2(rotation[2], rotation[0]) * 180 / Math.PI, 3),
      levelNormal: [0, 1, 0],
      physicalHardwareValidated: false,
    };
  });
}

async function extract(current, relative) {
  const legacy = legacyDefinition(relative, current);
  if (current.robotId === "openarm_v2_bimanual") {
    const transportShape = referenceCallsForCurrentDefinition(current, legacy)
      .filter((call) => call.method === "skills.transport")
      .map((call) => ({
        effector: call.args?.effector,
        approachFrame: call.args?.approachFrame,
        contactFrame: call.args?.contactFrame,
        liftFrame: call.args?.liftFrame,
        destinationFrame: call.args?.destinationFrame,
        placeFrame: call.args?.placeFrame,
        retreatFrame: call.args?.retreatFrame,
      }));
    const cacheKey = JSON.stringify({
      frames: current.frames,
      fixtures: current.fixtures.map((fixture) => fixture.collisionProxies || fixture.collisionProxy || null),
      transportShape,
    });
    if (!openArmActionCache.has(cacheKey)) openArmActionCache.set(cacheKey, await openArmPhysicalActions(current, legacy));
    return structuredClone(openArmActionCache.get(cacheKey));
  }
  const records = [];
  let callIndex = -1;
  let callArgs = {};
  const engine = await ScenarioV2Engine.create(current, {
    sleep: async () => {},
    onSample: (sample, _index, state) => records.push({ sample, state, callIndex, callArgs }),
    allowValidationSemanticCompilation: true,
  });
  try {
    const calls = referenceCallsForCurrentDefinition(current, legacy);
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      if (["lab.record_evidence", "skills.fixture_operation"].includes(call.method)) continue;
      callIndex = index; callArgs = call.args || {};
      // Legacy semantic traces predate the portable learner contract. Make the
      // required stow phase explicit in the extracted trace before each drive;
      // lekiwiActions emits the corresponding public send_action command.
      if (current.robotId === "lekiwi_sim" && call.method === "robot.navigate") {
        Object.assign(engine.state.jointState, engine.model.configured.stowJointState);
      }
      const response = await engine.call(call.method, call.args || {});
      if (!response.ok) throw new Error(`${current.id}/${call.method}: ${response.code} ${response.message}\n${JSON.stringify(response, null, 2)}`);
    }
  } finally { engine.dispose(); }
  if (current.robotId === "so101_follower") return soActions(records);
  if (current.robotId === "lekiwi_sim") return lekiwiActions(records);
  return openArmActions(records);
}

for (const source of sources()) {
  const relative = path.relative(root, source);
  const current = JSON.parse(fs.readFileSync(source, "utf8"));
  const actions = await extract(current, relative);
  if (!actions.length) throw new Error(`${current.id} produced no portable reference actions.`);
  current.portablePython.referenceActions = actions;
  await calibrateStableRestFromReference(current, actions);
  current.portablePython.referenceExecution = { id: "physical-style-python-reference", actionCount: actions.length, source: "legacy reviewed kinematic reference compiled to public pinned action fields", taskOutcomeExpected: true };
  assertScenarioV2(current, { expectedRobotId: current.robotId });
  fs.writeFileSync(source, `${JSON.stringify(current, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "missions/lab-assistant/v2/generated/scenarios", `${current.id}.json`), `${JSON.stringify(stripValidationForClient(current), null, 2)}\n`);
  console.log(`${current.id}: ${actions.length} actions`);
}
