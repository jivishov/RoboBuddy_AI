import {
  add3,
  clamp,
  composeTransform,
  deepClone,
  distance3,
  identityTransform,
  jointTransform,
  norm3,
  rotationFromAxisAngle,
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

function rootTransform(basePose = {}) {
  const position = basePose.positionMm || [0, 0, 0];
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
  const frames = { root: rootTransform(options.basePose) };
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

function numericalJacobian(model, state, chainId, activeJoints, endFrame, endOffsetMm, basePose, perturbDeg = 0.05) {
  const base = forwardKinematics(model, state, { chainId, endFrame, endOffsetMm, basePose }).positionMm;
  return [0, 1, 2].map((dimension) => activeJoints.map((jointId) => {
    const perturbed = { ...state, [jointId]: Number(state[jointId]) + perturbDeg };
    const point = forwardKinematics(model, perturbed, { chainId, endFrame, endOffsetMm, basePose }).positionMm;
    return (point[dimension] - base[dimension]) / perturbDeg;
  }));
}

function dlsStep(jacobian, error, damping) {
  const count = jacobian[0].length;
  const normal = Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, column) => (
    jacobian[0][row] * jacobian[0][column]
    + jacobian[1][row] * jacobian[1][column]
    + jacobian[2][row] * jacobian[2][column]
    + (row === column ? damping * damping : 0)
  )));
  const rhs = Array.from({ length: count }, (_, index) => (
    jacobian[0][index] * error[0]
    + jacobian[1][index] * error[1]
    + jacobian[2][index] * error[2]
  ));
  return solveLinearSystem(normal, rhs);
}

function candidateSeeds(model, chainId, initial, seed, count) {
  const limits = jointLimits(model, chainId);
  const random = seededRandom(seed);
  const home = Object.fromEntries(limits.map((item) => [item.id, item.home]));
  const candidates = [clampJointState(model, { ...home, ...initial }, chainId), home];
  while (candidates.length < count) {
    candidates.push(Object.fromEntries(limits.map((item) => [item.id, item.min + random() * (item.max - item.min)])));
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
  const starts = candidateSeeds(model, chainId, options.initialJointState || {}, Number(options.seed || 17), Math.max(2, Number(options.starts || 8)));
  let best = { ok: false, code: "IK_UNREACHABLE", errorMm: Infinity, jointState: starts[0], iterations: 0, seedIndex: 0 };
  starts.forEach((seedState, seedIndex) => {
    let state = { ...seedState };
    let stagnant = 0;
    let priorError = Infinity;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const current = forwardKinematics(model, state, {
        chainId,
        endFrame: options.endFrame,
        endOffsetMm: options.endOffsetMm,
        basePose: options.basePose
      }).positionMm;
      const errorVector = sub3(targetMm, current);
      const errorMm = norm3(errorVector);
      if (errorMm < best.errorMm) best = { ok: errorMm <= toleranceMm, code: errorMm <= toleranceMm ? "IK_SOLVED" : "IK_UNREACHABLE", errorMm, jointState: { ...state }, iterations: iteration + 1, seedIndex };
      if (errorMm <= toleranceMm) break;
      stagnant = Math.abs(priorError - errorMm) < 1e-5 ? stagnant + 1 : 0;
      if (stagnant > 12) break;
      priorError = errorMm;
      const jacobian = numericalJacobian(model, state, chainId, activeJoints, options.endFrame, options.endOffsetMm, options.basePose);
      const delta = dlsStep(jacobian, errorVector, damping);
      if (!delta || delta.some((value) => !Number.isFinite(value))) break;
      const proposed = { ...state };
      activeJoints.forEach((jointId, index) => {
        proposed[jointId] = Number(state[jointId]) + clamp(delta[index], -10, 10);
      });
      state = clampJointState(model, proposed, chainId);
    }
  });
  return { ...best, targetMm: [...targetMm], withinLimits: withinJointLimits(model, best.jointState, chainId) };
}

export function ikRoundTrip(model, jointState, options = {}) {
  const forward = forwardKinematics(model, jointState, options);
  const inverse = inverseKinematics(model, forward.positionMm, { ...options, initialJointState: options.initialJointState || homeJointState(model) });
  const reconstructed = inverse.ok ? forwardKinematics(model, inverse.jointState, options).positionMm : [Infinity, Infinity, Infinity];
  return { forward, inverse, positionErrorMm: distance3(forward.positionMm, reconstructed) };
}
