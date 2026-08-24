import { clamp, distance3, seededRandom } from "./math.js";
import { clampJointState, jointLimits } from "./kinematics.js";
import { stateCollisionReport } from "./collision.js";

function stateDistance(a, b, ids) {
  return Math.hypot(...ids.map((id) => Number(a[id]) - Number(b[id])));
}

function interpolateState(a, b, ids, t) {
  return Object.fromEntries(ids.map((id) => [id, Number(a[id]) + (Number(b[id]) - Number(a[id])) * t]));
}

function withFixedState(state, options = {}) {
  return { ...(options.fixedJointState || {}), ...state };
}

export function interpolateJointPath(model, start, goal, options = {}) {
  const chainId = options.chainId || "default";
  const limits = jointLimits(model, chainId);
  const ids = limits.map((item) => item.id);
  const from = clampJointState(model, start, chainId);
  const to = clampJointState(model, goal, chainId);
  const maxDelta = Math.max(0, ...ids.map((id) => Math.abs(Number(to[id]) - Number(from[id]))));
  const steps = Math.max(1, Math.ceil(maxDelta / Math.max(0.1, Number(options.maxStepDeg || 4))));
  return Array.from({ length: steps + 1 }, (_, index) => withFixedState(interpolateState(from, to, ids, index / steps), options));
}

export function validateJointPath(model, path, obstacles = [], options = {}) {
  const reports = path.map((state, index) => {
    const collision = stateCollisionReport(model, state, obstacles, options);
    const stateConstraintOk = typeof options.acceptState !== "function" || options.acceptState(state);
    return {
      index,
      ...collision,
      ok: collision.ok && stateConstraintOk,
      ...(!stateConstraintOk ? { constraintFailure: options.constraintFailureCode || "STATE_CONSTRAINT" } : {}),
    };
  });
  const failure = reports.find((item) => !item.ok);
  return { ok: !failure, failure: failure || null, reports };
}

function nearestIndex(tree, state, ids) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  tree.forEach((node, index) => {
    const value = stateDistance(node.state, state, ids);
    if (value < bestDistance) { bestDistance = value; bestIndex = index; }
  });
  return bestIndex;
}

function steer(from, to, ids, stepDeg) {
  const distance = stateDistance(from, to, ids);
  if (distance <= stepDeg) return { ...to };
  const ratio = stepDeg / distance;
  return interpolateState(from, to, ids, ratio);
}

function collisionFreeSegment(model, from, to, obstacles, options) {
  const path = interpolateJointPath(model, from, to, { ...options, maxStepDeg: options.collisionStepDeg || 4 });
  return validateJointPath(model, path, obstacles, options).ok;
}

function pathToRoot(tree, index) {
  const path = [];
  let cursor = index;
  while (cursor >= 0) {
    path.push(tree[cursor].state);
    cursor = tree[cursor].parent;
  }
  return path.reverse();
}

export function rrtConnect(model, start, goal, obstacles = [], options = {}) {
  const chainId = options.chainId || "default";
  const limits = jointLimits(model, chainId);
  const ids = limits.map((item) => item.id);
  const random = seededRandom(Number(options.seed ?? 31));
  const sample = () => Object.fromEntries(limits.map((item) => [item.id, item.min + random() * (item.max - item.min)]));
  const stepDeg = Math.max(2, Number(options.rrtStepDeg || 14));
  const maxIterations = Math.max(1, Number(options.maxIterations || 1600));
  let first = [{ state: clampJointState(model, start, chainId), parent: -1 }];
  let second = [{ state: clampJointState(model, goal, chainId), parent: -1 }];
  let swapped = false;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const target = iteration % 7 === 0 ? second[0].state : sample();
    const nearIndex = nearestIndex(first, target, ids);
    const next = steer(first[nearIndex].state, target, ids, stepDeg);
    if (!collisionFreeSegment(model, first[nearIndex].state, next, obstacles, { ...options, chainId })) {
      [first, second] = [second, first]; swapped = !swapped; continue;
    }
    first.push({ state: next, parent: nearIndex });
    let connectIndex = nearestIndex(second, next, ids);
    let connected = false;
    for (let extension = 0; extension < 80; extension += 1) {
      const candidate = steer(second[connectIndex].state, next, ids, stepDeg);
      if (!collisionFreeSegment(model, second[connectIndex].state, candidate, obstacles, { ...options, chainId })) break;
      second.push({ state: candidate, parent: connectIndex });
      connectIndex = second.length - 1;
      if (stateDistance(candidate, next, ids) <= 1e-5) { connected = true; break; }
    }
    if (connected) {
      const a = pathToRoot(first, first.length - 1);
      const b = pathToRoot(second, connectIndex).reverse();
      const nodes = swapped ? [...b.reverse(), ...a.reverse().slice(1)] : [...a, ...b.slice(1)];
      const dense = nodes.flatMap((state, index) => index === nodes.length - 1 ? [state] : interpolateJointPath(model, state, nodes[index + 1], { chainId, maxStepDeg: options.maxStepDeg || 4 }).slice(0, -1));
      return { ok: true, code: "RRT_CONNECT", path: dense, iterations: iteration + 1, seed: Number(options.seed ?? 31) };
    }
    [first, second] = [second, first];
    swapped = !swapped;
  }
  return { ok: false, code: "NO_COLLISION_FREE_PATH", path: [], iterations: maxIterations, seed: Number(options.seed ?? 31) };
}

export function planJointPath(model, start, goal, obstacles = [], options = {}) {
  const direct = interpolateJointPath(model, start, goal, options);
  // Collision checking may need a finer temporal resolution than the returned
  // command path. This catches narrow payload/object intersections without
  // bloating the public reference action sequence.
  const validationPath = Number(options.collisionStepDeg) > 0 && Number(options.collisionStepDeg) < Number(options.maxStepDeg || 4)
    ? interpolateJointPath(model, start, goal, { ...options, maxStepDeg: options.collisionStepDeg })
    : direct;
  const validation = validateJointPath(model, validationPath, obstacles, options);
  if (validation.ok) return { ok: true, code: "BOUNDED_INTERPOLATION", path: direct, direct: true };
  if (options.allowRrt === false) return { ok: false, code: "DIRECT_PATH_BLOCKED", path: [], direct: false, directFailure: validation.failure };
  return { ...rrtConnect(model, start, goal, obstacles, options), direct: false, directFailure: validation.failure };
}

function gridKey(x, y) { return `${x},${y}`; }

export function planOccupancyGridAStar(grid, startMm, goalMm, options = {}) {
  const resolutionMm = Number(grid.resolutionMm || options.resolutionMm || 50);
  const originMm = grid.originMm || [0, 0];
  const width = Number(grid.width);
  const height = Number(grid.height);
  const blocked = new Set(grid.blocked || []);
  const toCell = (point) => [Math.round((point[0] - originMm[0]) / resolutionMm), Math.round((point[1] - originMm[1]) / resolutionMm)];
  const toPoint = (cell) => [originMm[0] + cell[0] * resolutionMm, originMm[1] + cell[1] * resolutionMm];
  const start = toCell(startMm);
  const goal = toCell(goalMm);
  const inside = ([x, y]) => x >= 0 && y >= 0 && x < width && y < height;
  if (!inside(start) || !inside(goal) || blocked.has(gridKey(...start)) || blocked.has(gridKey(...goal))) return { ok: false, code: "INVALID_GRID_ENDPOINT", pathMm: [] };
  const open = [{ cell: start, g: 0, f: distance3([start[0], start[1], 0], [goal[0], goal[1], 0]) }];
  const best = new Map([[gridKey(...start), 0]]);
  const parent = new Map();
  const directions = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
  while (open.length) {
    open.sort((a, b) => a.f - b.f || a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1]);
    const current = open.shift();
    const key = gridKey(...current.cell);
    if (key === gridKey(...goal)) {
      const cells = [goal];
      let cursor = key;
      while (parent.has(cursor)) { cursor = parent.get(cursor); cells.push(cursor.split(",").map(Number)); }
      cells.reverse();
      return { ok: true, code: "A_STAR", cells, pathMm: cells.map(toPoint), costMm: current.g * resolutionMm };
    }
    directions.forEach(([dx, dy]) => {
      const next = [current.cell[0] + dx, current.cell[1] + dy];
      const nextKey = gridKey(...next);
      if (!inside(next) || blocked.has(nextKey)) return;
      if (dx && dy && (blocked.has(gridKey(current.cell[0] + dx, current.cell[1])) || blocked.has(gridKey(current.cell[0], current.cell[1] + dy)))) return;
      const g = current.g + (dx && dy ? Math.SQRT2 : 1);
      if (g >= (best.get(nextKey) ?? Infinity)) return;
      best.set(nextKey, g);
      parent.set(nextKey, key);
      const h = Math.hypot(goal[0] - next[0], goal[1] - next[1]);
      open.push({ cell: next, g, f: g + h });
    });
  }
  return { ok: false, code: "NO_GRID_PATH", pathMm: [] };
}

export function requireStowedForDrive(model, jointState, toleranceDeg = 3) {
  if (!model.capabilities.includes("stow_before_drive")) return { ok: true, code: "NOT_REQUIRED" };
  const stow = model.configured.stowJointState || {};
  const violations = Object.entries(stow).filter(([id, value]) => id !== "gripper" && Math.abs(Number(jointState[id]) - Number(value)) > toleranceDeg);
  return { ok: violations.length === 0, code: violations.length ? "ARM_NOT_STOWED" : "ARM_STOWED", violations: violations.map(([jointId]) => jointId) };
}
