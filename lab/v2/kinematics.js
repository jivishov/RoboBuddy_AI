import {
  add3,
  clamp,
  composeTransform,
  cross3,
  deepClone,
  distance3,
  dot3,
  identityTransform,
  jointTransform,
  norm3,
  normalize3,
  rotationFromAxisAngle,
  rotate3,
  seededRandom,
  solveLinearSystem,
  sub3,
  transformPoint
} from "./math.js";
import { homeJointState } from "./robot-model-catalog.js";

function chainFor(model, chainId = "default") {
  const chain = model?.chains?.[chainId];
  if (!chain) throw new Error(`Canonical chain ${chainId} is unavailable for ${model?.id || "unknown model"}.`);
  return chain;
}

function rootTransform(model, basePose = {}) {
  const position = add3(basePose.positionMm || [0, 0, 0], model?.rendererRootOffsetMm || [0, 0, 0]);
  const heading = Number(basePose.headingDeg || 0) * Math.PI / 180;
  return { position: [...position], rotation: rotationFromAxisAngle([0, 1, 0], heading) };
}

export function jointLimits(model, chainId = "default") {
  const chain = chainFor(model, chainId);
  const modelJoints = new Map((model.joints || []).map((item) => [item.id, item]));
  const seen = new Set();
  return chain.joints.flatMap((item) => {
    if (!item.jointId || seen.has(item.jointId)) return [];
    seen.add(item.jointId);
    const definition = modelJoints.get(item.jointId);
    if (definition?.type === "gripper") return [];
    const limits = item.limitsDeg || (definition ? [definition.min, definition.max] : [-180, 180]);
    return [{ id: item.jointId, min: Number(limits[0]), max: Number(limits[1]), home: Number(definition?.home || 0) }];
  });
}

export function clampJointState(model, state = {}, chainId = "default") {
  const next = { ...state };
  jointLimits(model, chainId).forEach((item) => {
    const value = Number(next[item.id] ?? item.home);
    next[item.id] = clamp(Number.isFinite(value) ? value : item.home, item.min, item.max);
  });
  return next;
}

export function withinJointLimits(model, state = {}, chainId = "default", tolerance = 1e-7) {
  return jointLimits(model, chainId).every((item) => {
    const value = Number(state[item.id] ?? item.home);
    return Number.isFinite(value) && value >= item.min - tolerance && value <= item.max + tolerance;
  });
}

export function forwardKinematics(model, jointState = {}, options = {}) {
  const chain = chainFor(model, options.chainId || "default");
  const frames = { root: rootTransform(model, options.basePose) };
  const state = { ...homeJointState(model), ...jointState };
  chain.joints.forEach((item) => {
    const parent = frames[item.parent] || frames.root;
    const raw = item.jointId ? Number(state[item.jointId] ?? 0) : 0;
    const degrees = item.jointId
      ? Number(item.sign ?? 1) * (raw - Number(item.zeroDeg || 0)) + Number(item.offsetDeg || 0)
      : Number(item.offsetDeg || 0);
    frames[item.id] = composeTransform(parent, jointTransform(
      item.pivotMm || item.pivot || [0, 0, 0],
      item.axis || [0, 1, 0],
      degrees * Math.PI / 180,
      item.baseQuat || [0, 0, 0, 1]
    ));
  });
  const endFrameId = options.endFrame || chain.endFrame;
  const endTransform = frames[endFrameId];
  if (!endTransform) throw new Error(`End frame ${endFrameId} is unavailable in chain ${chain.id}.`);
  const endOffset = options.endOffsetMm || chain.endOffsetMm || [0, 0, 0];
  return {
    modelId: model.id,
    chainId: chain.id,
    jointState: deepClone(state),
    frames,
    endFrame: endFrameId,
    positionMm: transformPoint(endTransform, endOffset),
    transform: endTransform
  };
}

function directionError(rotation, constraint = {}) {
  if (!constraint?.localVector || !constraint?.targetVector) return { angleRad: 0, vector: [0, 0, 0], current: null, target: null };
  const current = normalize3(rotate3(rotation, constraint.localVector));
  const target = normalize3(constraint.targetVector);
  const cosine = clamp(dot3(current, target), -1, 1);
  const angleRad = Math.acos(cosine);
  const cross = cross3(current, target);
  const crossLength = norm3(cross);
  const axis = crossLength > 1e-9 ? cross.map((value) => value / crossLength) : [0, 0, 0];
  return { angleRad, vector: axis.map((value) => value * angleRad), current, target };
}

function directionVectors(constraint) {
  if (!constraint) return [];
  const vectors = [{ localVector: constraint.localVector, targetVector: constraint.targetVector }];
  if (constraint.secondaryLocalVector && constraint.secondaryTargetVector) vectors.push({
    localVector: constraint.secondaryLocalVector,
    targetVector: constraint.secondaryTargetVector,
  });
  return vectors.filter((item) => item.localVector && item.targetVector);
}

function numericalJacobian(model, state, chainId, activeJoints, endFrame, endOffsetMm, basePose, directionConstraint, perturbDeg = 0.05) {
  const base = forwardKinematics(model, state, { chainId, endFrame, endOffsetMm, basePose });
  const positionRows = [0, 1, 2].map((dimension) => activeJoints.map((jointId) => {
    const perturbed = { ...state, [jointId]: Number(state[jointId]) + perturbDeg };
    const point = forwardKinematics(model, perturbed, { chainId, endFrame, endOffsetMm, basePose }).positionMm;
    return (point[dimension] - base.positionMm[dimension]) / perturbDeg;
  }));
  if (!directionConstraint) return positionRows;
  const weight = Math.max(1, Number(directionConstraint.weightMmPerRad || 120));
  const directionRows = directionVectors(directionConstraint).flatMap((vector) => {
    const baseDirection = normalize3(rotate3(base.transform.rotation, vector.localVector));
    const directionColumns = activeJoints.map((jointId) => {
      const perturbed = { ...state, [jointId]: Number(state[jointId]) + perturbDeg };
      const rotation = forwardKinematics(model, perturbed, { chainId, endFrame, endOffsetMm, basePose }).transform.rotation;
      const nextDirection = normalize3(rotate3(rotation, vector.localVector));
      const delta = directionError(
        [1, 0, 0, 0, 1, 0, 0, 0, 1],
        { localVector: baseDirection, targetVector: nextDirection }
      ).vector;
      return delta.map((value) => value * weight / perturbDeg);
    });
    return [0, 1, 2].map((dimension) => directionColumns.map((column) => column[dimension]));
  });
  return [...positionRows, ...directionRows];
}

function dlsStep(jacobian, error, damping) {
  const count = jacobian[0].length;
  const normal = Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, column) => (
    jacobian.reduce((sum, values) => sum + values[row] * values[column], 0)
    + (row === column ? damping * damping : 0)
  )));
  const rhs = Array.from({ length: count }, (_, index) => (
    jacobian.reduce((sum, values, row) => sum + values[index] * error[row], 0)
  ));
  return solveLinearSystem(normal, rhs);
}

function candidateSeeds(model, chainId, initial, seed, count, activeJoints) {
  const limits = jointLimits(model, chainId);
  const random = seededRandom(seed);
  const active = new Set(activeJoints || limits.map((item) => item.id));
  const home = Object.fromEntries(limits.map((item) => [item.id, item.home]));
  const initialState = clampJointState(model, { ...home, ...initial }, chainId);
  const activeHome = {
    ...initialState,
    ...Object.fromEntries(limits.filter((item) => active.has(item.id)).map((item) => [item.id, item.home]))
  };
  const candidates = [initialState, activeHome];
  while (candidates.length < count) {
    candidates.push({
      ...initialState,
      ...Object.fromEntries(limits.filter((item) => active.has(item.id)).map((item) => [item.id, item.min + random() * (item.max - item.min)]))
    });
  }
  return candidates;
}

export function inverseKinematics(model, targetMm, options = {}) {
  if (!Array.isArray(targetMm) || targetMm.length !== 3 || !targetMm.every(Number.isFinite)) {
    throw new Error("IK target must be a finite [x, y, z] position in millimeters.");
  }
  const chainId = options.chainId || "default";
  const limits = jointLimits(model, chainId);
  if (!limits.length) return { ok: false, code: "IK_UNSUPPORTED", errorMm: Infinity, jointState: {} };
  const activeJoints = options.activeJoints?.length ? options.activeJoints : limits.map((item) => item.id);
  const toleranceMm = Number(options.toleranceMm || 2.5);
  const maxIterations = Math.max(1, Number(options.maxIterations || 180));
  const damping = Math.max(0.001, Number(options.damping || 0.35));
  const directionConstraint = options.directionConstraint?.localVector && options.directionConstraint?.targetVector
    ? {
      ...options.directionConstraint,
      toleranceDeg: Math.max(0.05, Number(options.directionConstraint.toleranceDeg || 2)),
      weightMmPerRad: Math.max(1, Number(options.directionConstraint.weightMmPerRad || 120)),
    }
    : null;
  const starts = candidateSeeds(model, chainId, options.initialJointState || {}, Number(options.seed ?? 17), Math.max(2, Number(options.starts ?? 8)), activeJoints);
  let best = { ok: false, code: "IK_UNREACHABLE", errorMm: Infinity, orientationErrorDeg: directionConstraint ? Infinity : 0, combinedError: Infinity, jointState: starts[0], iterations: 0, seedIndex: 0 };
  let bestAccepted = null;
  let convergedCount = 0;
  let rejectedCount = 0;
  for (let seedIndex = 0; seedIndex < starts.length; seedIndex += 1) {
    const seedState = starts[seedIndex];
    let state = { ...seedState };
    let stagnant = 0;
    let priorError = Infinity;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const current = forwardKinematics(model, state, {
        chainId,
        endFrame: options.endFrame,
        endOffsetMm: options.endOffsetMm,
        basePose: options.basePose
      });
      const positionError = sub3(targetMm, current.positionMm);
      const errorMm = norm3(positionError);
      const orientations = directionVectors(directionConstraint).map((vector) => directionError(current.transform.rotation, vector));
      const orientationErrorDeg = Math.max(0, ...orientations.map((orientation) => orientation.angleRad * 180 / Math.PI));
      const weightedOrientationError = orientations.flatMap((orientation) => orientation.vector.map((value) => value * Number(directionConstraint?.weightMmPerRad || 0)));
      const errorVector = [...positionError, ...(directionConstraint ? weightedOrientationError : [])];
      const combinedError = norm3(positionError) + Math.hypot(...weightedOrientationError);
      const converged = errorMm <= toleranceMm && (!directionConstraint || orientationErrorDeg <= directionConstraint.toleranceDeg);
      if (combinedError < best.combinedError) best = { ok: converged, code: converged ? "IK_SOLVED" : "IK_UNREACHABLE", errorMm, orientationErrorDeg, combinedError, jointState: { ...state }, iterations: iteration + 1, seedIndex };
      if (converged) {
        convergedCount += 1;
        const accepted = typeof options.acceptJointState !== "function" || options.acceptJointState({ ...state });
        if (accepted) {
          const configuredScore = typeof options.scoreJointState === "function"
            ? Number(options.scoreJointState({ ...state }))
            : errorMm;
          const selectionScore = Number.isFinite(configuredScore) ? configuredScore : Infinity;
          const solved = { ok: true, code: "IK_SOLVED", errorMm, orientationErrorDeg, combinedError, jointState: { ...state }, iterations: iteration + 1, seedIndex, selectionScore };
          if (
            !bestAccepted
            || selectionScore < bestAccepted.selectionScore - 1e-9
            || (Math.abs(selectionScore - bestAccepted.selectionScore) <= 1e-9 && errorMm < bestAccepted.errorMm)
          ) bestAccepted = solved;
        } else rejectedCount += 1;
        break;
      }
      stagnant = Math.abs(priorError - combinedError) < 1e-5 ? stagnant + 1 : 0;
      if (stagnant > 12) break;
      priorError = combinedError;
      const jacobian = numericalJacobian(model, state, chainId, activeJoints, options.endFrame, options.endOffsetMm, options.basePose, directionConstraint);
      const delta = dlsStep(jacobian, errorVector, damping);
      if (!delta || delta.some((value) => !Number.isFinite(value))) break;
      const proposed = { ...state };
      activeJoints.forEach((jointId, index) => {
        proposed[jointId] = Number(state[jointId]) + clamp(delta[index], -10, 10);
      });
      state = clampJointState(model, proposed, chainId);
    }
    if (bestAccepted && options.stopOnFirstAccepted === true) break;
  }
  const selected = bestAccepted || (convergedCount > 0
    ? { ...best, ok: false, code: "IK_GOAL_BLOCKED" }
    : best);
  return {
    ...selected,
    targetMm: [...targetMm],
    withinLimits: withinJointLimits(model, selected.jointState, chainId),
    diagnostics: { convergedCount, rejectedCount }
  };
}

export function ikRoundTrip(model, jointState, options = {}) {
  const forward = forwardKinematics(model, jointState, options);
  const inverse = inverseKinematics(model, forward.positionMm, { ...options, initialJointState: options.initialJointState || homeJointState(model) });
  const reconstructed = inverse.ok ? forwardKinematics(model, inverse.jointState, options).positionMm : [Infinity, Infinity, Infinity];
  return { forward, inverse, positionErrorMm: distance3(forward.positionMm, reconstructed) };
}
