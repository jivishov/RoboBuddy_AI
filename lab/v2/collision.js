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
  if (proxy.type === "box") {
    const frame = fk.frames[proxy.frameId || "root"];
    if (!frame) return null;
    const corners = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => transformPoint(frame, [
      proxy.centerMm[0] + x * proxy.halfExtentsMm[0],
      proxy.centerMm[1] + y * proxy.halfExtentsMm[1],
      proxy.centerMm[2] + z * proxy.halfExtentsMm[2]
    ]))));
    const minimum = [0, 1, 2].map((axis) => Math.min(...corners.map((point) => point[axis])));
    const maximum = [0, 1, 2].map((axis) => Math.max(...corners.map((point) => point[axis])));
    return {
      ...proxy,
      centerMm: minimum.map((value, axis) => (value + maximum[axis]) / 2),
      halfExtentsMm: minimum.map((value, axis) => (maximum[axis] - value) / 2)
    };
  }
  return null;
}

function rendererForwardKinematics(model, jointState, options = {}) {
  if (!model.rendererChain?.length) return null;
  const rendererModel = {
    ...model,
    chains: {
      renderer: {
        id: "renderer",
        joints: model.rendererChain,
        endFrame: model.rendererChain.at(-1).id
      }
    }
  };
  return forwardKinematics(rendererModel, jointState, { chainId: "renderer", basePose: options.basePose });
}

export function collisionGeometry(model, jointState, options = {}) {
  const fkByChain = {};
  Object.keys(model.chains || {}).forEach((chainId) => {
    fkByChain[chainId] = forwardKinematics(model, jointState, { chainId, basePose: options.basePose });
  });
  const rendererFk = rendererForwardKinematics(model, jointState, options);
  const fallback = rendererFk || Object.values(fkByChain)[0] || {
    frames: {
      root: {
        position: add3(options.basePose?.positionMm || [0, 0, 0], model.rendererRootOffsetMm || [0, 0, 0]),
        rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1]
      }
    }
  };
  return (model.collisionProxies || []).map((proxy) => {
    const chainFk = (proxy.frameId && rendererFk?.frames[proxy.frameId] ? rendererFk : null)
      || Object.values(fkByChain).find((fk) => (
      (!proxy.fromFrame || fk.frames[proxy.fromFrame]) && (!proxy.toFrame || fk.frames[proxy.toFrame])
    )) || fallback;
    if (proxy.type === "box" && !proxy.frameId) {
      return {
        ...proxy,
        centerMm: add3(proxy.centerMm, options.basePose?.positionMm || [0, 0, 0]),
        halfExtentsMm: [...proxy.halfExtentsMm]
      };
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
  if (model.renderGeometrySamples?.length) {
    const rendererFk = rendererForwardKinematics(model, jointState, options);
    const chainFks = Object.keys(model.chains || {}).map((chainId) => forwardKinematics(model, jointState, { chainId, basePose: options.basePose }));
    return model.renderGeometrySamples.flatMap((sample) => {
      const frame = rendererFk?.frames[sample.frameId]
        || chainFks.find((fk) => fk.frames[sample.frameId])?.frames[sample.frameId];
      return frame ? [{ ...sample, pointMm: transformPoint(frame, sample.localPointMm) }] : [];
    });
  }
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
  const samples = options.samples || sampleRenderedGeometry(model, jointState, options);
  const violations = samples.flatMap((sample) => {
    const margins = proxies.map((proxy) => ({
      proxyId: proxy.id,
      marginMm: proxy.type === "capsule"
        ? proxy.radiusMm - pointSegmentDistance(sample.pointMm, proxy.startMm, proxy.endMm)
        : Math.min(...sample.pointMm.map((value, index) => proxy.halfExtentsMm[index] - Math.abs(value - proxy.centerMm[index])))
    })).sort((a, b) => b.marginMm - a.marginMm);
    const best = margins[0];
    return best && best.marginMm >= -1e-6
      ? []
      : [{ ...sample, nearestProxyId: best?.proxyId || null, marginMm: best?.marginMm ?? -Infinity, reason: "outside conservative proxy union" }];
  });
  return {
    ok: samples.length > 0 && violations.length === 0,
    sampleCount: samples.length,
    sampleProvenance: samples.length ? "authored-or-baked-renderer-mesh" : "unavailable",
    violations
  };
}
