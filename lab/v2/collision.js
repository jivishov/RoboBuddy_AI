import { add3, clamp, distance3, dot3, norm3, scale3, sub3, transformPoint } from "./math.js";
import { forwardKinematics } from "./kinematics.js";

function pointSegmentDistance(point, start, end) {
  const segment = sub3(end, start);
  const denominator = dot3(segment, segment);
  const t = denominator <= 1e-9 ? 0 : clamp(dot3(sub3(point, start), segment) / denominator, 0, 1);
  return distance3(point, add3(start, scale3(segment, t)));
}

function pointAabbDistance(point, center, halfExtents) {
  const delta = point.map((value, index) => Math.max(0, Math.abs(value - center[index]) - halfExtents[index]));
  return norm3(delta);
}

function segmentAabbDistance(start, end, center, halfExtents) {
  let best = Infinity;
  for (let index = 0; index <= 20; index += 1) {
    const t = index / 20;
    const point = start.map((value, axis) => value + (end[axis] - value) * t);
    best = Math.min(best, pointAabbDistance(point, center, halfExtents));
  }
  return best;
}

function segmentSegmentDistance(p1, q1, p2, q2) {
  const d1 = sub3(q1, p1);
  const d2 = sub3(q2, p2);
  const r = sub3(p1, p2);
  const a = dot3(d1, d1);
  const e = dot3(d2, d2);
  const f = dot3(d2, r);
  let s;
  let t;
  if (a <= 1e-9 && e <= 1e-9) return distance3(p1, p2);
  if (a <= 1e-9) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = dot3(d1, r);
    if (e <= 1e-9) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = dot3(d1, d2);
      const denominator = a * e - b * b;
      s = denominator === 0 ? 0 : clamp((b * f - c * e) / denominator, 0, 1);
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  return distance3(add3(p1, scale3(d1, s)), add3(p2, scale3(d2, t)));
}

function worldProxy(proxy, fk) {
  if (proxy.type === "capsule") {
    const start = fk.frames[proxy.fromFrame]?.position;
    const end = fk.frames[proxy.toFrame]?.position;
    if (!start || !end) return null;
    return { ...proxy, startMm: [...start], endMm: [...end] };
  }
  if (proxy.type === "box") return { ...proxy, centerMm: [...proxy.centerMm], halfExtentsMm: [...proxy.halfExtentsMm] };
  return null;
}

export function collisionGeometry(model, jointState, options = {}) {
  const fkByChain = {};
  Object.keys(model.chains || {}).forEach((chainId) => {
    fkByChain[chainId] = forwardKinematics(model, jointState, { chainId, basePose: options.basePose });
  });
  const fallback = Object.values(fkByChain)[0] || { frames: { root: { position: options.basePose?.positionMm || [0, 0, 0] } } };
  return (model.collisionProxies || []).map((proxy) => {
    const chainFk = Object.values(fkByChain).find((fk) => (
      (!proxy.fromFrame || fk.frames[proxy.fromFrame]) && (!proxy.toFrame || fk.frames[proxy.toFrame])
    )) || fallback;
    if (proxy.type === "box" && options.basePose?.positionMm) {
      return { ...proxy, centerMm: add3(proxy.centerMm, options.basePose.positionMm), halfExtentsMm: [...proxy.halfExtentsMm] };
    }
    return worldProxy(proxy, chainFk);
  }).filter(Boolean);
}

export function proxiesCollide(a, b) {
  if (a.type === "capsule" && b.type === "box") return segmentAabbDistance(a.startMm, a.endMm, b.centerMm, b.halfExtentsMm) <= a.radiusMm;
  if (a.type === "box" && b.type === "capsule") return proxiesCollide(b, a);
  if (a.type === "capsule" && b.type === "capsule") return segmentSegmentDistance(a.startMm, a.endMm, b.startMm, b.endMm) <= a.radiusMm + b.radiusMm;
  if (a.type === "box" && b.type === "box") return [0, 1, 2].every((index) => Math.abs(a.centerMm[index] - b.centerMm[index]) <= a.halfExtentsMm[index] + b.halfExtentsMm[index]);
  return false;
}

export function stateCollisionReport(model, jointState, obstacles = [], options = {}) {
  const robot = collisionGeometry(model, jointState, options);
  const collisions = [];
  robot.forEach((proxy) => {
    obstacles.forEach((obstacle) => {
      const normalized = obstacle.type === "box"
        ? obstacle
        : obstacle.type === "capsule"
          ? { ...obstacle, startMm: obstacle.startMm || obstacle.fromMm, endMm: obstacle.endMm || obstacle.toMm }
          : null;
      if (normalized && proxiesCollide(proxy, normalized)) collisions.push({ robotProxyId: proxy.id, obstacleId: obstacle.id || "obstacle" });
    });
  });
  return { ok: collisions.length === 0, collisions, proxies: robot };
}

export function sampleRenderedGeometry(model, jointState = {}, options = {}) {
  const proxies = collisionGeometry(model, jointState, options);
  return proxies.flatMap((proxy) => {
    if (proxy.type === "box") {
      return [-0.9, 0, 0.9].flatMap((x) => [-0.9, 0.9].flatMap((y) => [-0.9, 0.9].map((z) => ({
        proxyId: proxy.id,
        pointMm: proxy.centerMm.map((value, index) => value + proxy.halfExtentsMm[index] * [x, y, z][index])
      }))));
    }
    const midpoint = proxy.startMm.map((value, index) => (value + proxy.endMm[index]) / 2);
    const radial = proxy.radiusMm * 0.85;
    return [proxy.startMm, midpoint, proxy.endMm].flatMap((point) => [
      { proxyId: proxy.id, pointMm: [...point] },
      { proxyId: proxy.id, pointMm: add3(point, [radial, 0, 0]) },
      { proxyId: proxy.id, pointMm: add3(point, [0, 0, radial]) }
    ]);
  });
}

export function validateProxyEnclosure(model, jointState = {}, options = {}) {
  const proxies = collisionGeometry(model, jointState, options);
  const byId = new Map(proxies.map((item) => [item.id, item]));
  const samples = options.samples || sampleRenderedGeometry(model, jointState, options);
  const violations = samples.flatMap((sample) => {
    const proxy = byId.get(sample.proxyId);
    if (!proxy) return [{ ...sample, reason: "missing proxy" }];
    const margin = proxy.type === "capsule"
      ? proxy.radiusMm - pointSegmentDistance(sample.pointMm, proxy.startMm, proxy.endMm)
      : Math.min(...sample.pointMm.map((value, index) => proxy.halfExtentsMm[index] - Math.abs(value - proxy.centerMm[index])));
    return margin >= -1e-6 ? [] : [{ ...sample, marginMm: margin, reason: "outside conservative proxy" }];
  });
  return { ok: violations.length === 0, sampleCount: samples.length, violations };
}
