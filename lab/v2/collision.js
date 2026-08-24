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

function boxAxes(box) {
  return Array.isArray(box.axes) && box.axes.length === 3
    ? box.axes
    : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}

function pointInBoxCoordinates(point, box) {
  const offset = sub3(point, box.centerMm);
  return boxAxes(box).map((axis) => dot3(offset, axis));
}

function capsuleBoxCollision(capsule, box) {
  const localStart = pointInBoxCoordinates(capsule.startMm, box);
  const localEnd = pointInBoxCoordinates(capsule.endMm, box);
  return segmentAabbDistance(localStart, localEnd, [0, 0, 0], box.halfExtentsMm) <= capsule.radiusMm;
}

// Full 15-axis separating-axis test for two oriented boxes. Robot mesh-bound
// boxes retain their FK rotation; authored fixture boxes use identity axes.
// This avoids both the empty swept volume of a rotated world AABB and the
// missed face/edge contacts of a sparse vertex-only test.
function boxesCollide(a, b) {
  const axesA = boxAxes(a);
  const axesB = boxAxes(b);
  const rotation = axesA.map((axisA) => axesB.map((axisB) => dot3(axisA, axisB)));
  const absolute = rotation.map((row) => row.map((value) => Math.abs(value) + 1e-8));
  const centerDelta = sub3(b.centerMm, a.centerMm);
  const translation = axesA.map((axis) => dot3(centerDelta, axis));

  for (let axis = 0; axis < 3; axis += 1) {
    const radiusA = a.halfExtentsMm[axis];
    const radiusB = b.halfExtentsMm.reduce((sum, extent, index) => sum + extent * absolute[axis][index], 0);
    if (Math.abs(translation[axis]) > radiusA + radiusB) return false;
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const radiusA = a.halfExtentsMm.reduce((sum, extent, index) => sum + extent * absolute[index][axis], 0);
    const radiusB = b.halfExtentsMm[axis];
    const projected = Math.abs(translation.reduce((sum, value, index) => sum + value * rotation[index][axis], 0));
    if (projected > radiusA + radiusB) return false;
  }
  for (let axisA = 0; axisA < 3; axisA += 1) {
    for (let axisB = 0; axisB < 3; axisB += 1) {
      const radiusA = a.halfExtentsMm[(axisA + 1) % 3] * absolute[(axisA + 2) % 3][axisB]
        + a.halfExtentsMm[(axisA + 2) % 3] * absolute[(axisA + 1) % 3][axisB];
      const radiusB = b.halfExtentsMm[(axisB + 1) % 3] * absolute[axisA][(axisB + 2) % 3]
        + b.halfExtentsMm[(axisB + 2) % 3] * absolute[axisA][(axisB + 1) % 3];
      const projected = Math.abs(
        translation[(axisA + 2) % 3] * rotation[(axisA + 1) % 3][axisB]
        - translation[(axisA + 1) % 3] * rotation[(axisA + 2) % 3][axisB]
      );
      if (projected > radiusA + radiusB) return false;
    }
  }
  return true;
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
    return {
      ...proxy,
      centerMm: transformPoint(frame, proxy.centerMm),
      halfExtentsMm: [...proxy.halfExtentsMm],
      axes: [
        [frame.rotation[0], frame.rotation[3], frame.rotation[6]],
        [frame.rotation[1], frame.rotation[4], frame.rotation[7]],
        [frame.rotation[2], frame.rotation[5], frame.rotation[8]]
      ]
    };
  }
  return null;
}

function rendererForwardKinematics(model, jointState, options = {}) {
  if (!model.rendererChain?.length) return null;
  const gripper = model.configured?.commandInterface?.gripper;
  const rendererJointState = { ...jointState };
  const rendererChain = model.id === "so101_follower" && gripper
    ? model.rendererChain.map((joint) => {
      if (joint.id !== gripper.rendererNode && joint.id !== "gripper_jaw") return joint;
      const value = Number(jointState[gripper.jointId] ?? gripper.openValue);
      const denominator = Math.max(1, Math.abs(gripper.graspValue - gripper.openValue));
      const openRatio = clamp((gripper.graspValue - value) / denominator, 0, 1);
      rendererJointState.__so101_gripper_visual = gripper.rendererClosedDeg + (gripper.rendererOpenDeg - gripper.rendererClosedDeg) * openRatio;
      return { ...joint, jointId: "__so101_gripper_visual", sign: 1, zeroDeg: 0, offsetDeg: 0 };
    })
    : model.rendererChain;
  const rendererModel = {
    ...model,
    chains: {
      renderer: {
        id: "renderer",
        joints: rendererChain,
        endFrame: rendererChain.at(-1).id
      }
    }
  };
  return forwardKinematics(rendererModel, rendererJointState, { chainId: "renderer", basePose: options.basePose });
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
  if (a.type === "capsule" && b.type === "box") return capsuleBoxCollision(a, b);
  if (a.type === "box" && b.type === "capsule") return proxiesCollide(b, a);
  if (a.type === "capsule" && b.type === "capsule") return segmentSegmentDistance(a.startMm, a.endMm, b.startMm, b.endMm) <= a.radiusMm + b.radiusMm;
  if (a.type === "box" && b.type === "box") return boxesCollide(a, b);
  return false;
}

export function stateCollisionReport(model, jointState, obstacles = [], options = {}) {
  const robot = collisionGeometry(model, jointState, options);
  const collisions = [];
  const contactSurfaceClearanceMm = Math.max(0, Number(options.contactSurfaceClearanceMm ?? 1));
  const contactSurfaces = obstacles.filter((obstacle) => obstacle.type === "box" && ["contact_surface", "contact_support"].includes(obstacle.planningRole));
  const structuralObstacles = obstacles.filter((obstacle) => !["contact_surface", "contact_support"].includes(obstacle.planningRole));
  robot.forEach((proxy) => {
    structuralObstacles.forEach((obstacle) => {
      const normalized = obstacle.type === "box"
        ? obstacle
        : obstacle.type === "capsule"
          ? { ...obstacle, startMm: obstacle.startMm || obstacle.fromMm, endMm: obstacle.endMm || obstacle.toMm }
          : null;
      if (normalized && proxiesCollide(proxy, normalized)) collisions.push({ robotProxyId: proxy.id, obstacleId: obstacle.id || "obstacle" });
    });
  });
  if (contactSurfaces.length) {
    // Mesh-frame OBBs are deliberately conservative and can fill the empty
    // concavity between curved OpenArm fingers. Near authored contact supports
    // use bounded baked-mesh surface samples instead; the plant still checks
    // them at every 20 ms state and browser acceptance inspects the visible
    // meshes independently. Worktops/supports themselves are never excluded.
    const samples = sampleRenderedGeometry(model, jointState, options);
    for (const sample of samples) {
      for (const surface of contactSurfaces) {
        const inside = sample.pointMm.every((value, axis) => (
          value >= Number(surface.centerMm[axis]) - Number(surface.halfExtentsMm[axis]) - contactSurfaceClearanceMm
          && value <= Number(surface.centerMm[axis]) + Number(surface.halfExtentsMm[axis]) + contactSurfaceClearanceMm
        ));
        if (inside) collisions.push({ robotProxyId: sample.proxyId || sample.id, obstacleId: surface.id || "contact-surface", geometry: "baked-renderer-sample", pointMm: [...sample.pointMm] });
      }
    }
  }
  return { ok: collisions.length === 0, collisions, proxies: robot };
}

function sampleGeometryInWorld(model, configuredSamples, jointState = {}, options = {}) {
  if (configuredSamples?.length) {
    const rendererFk = rendererForwardKinematics(model, jointState, options);
    const chainFks = Object.keys(model.chains || {}).map((chainId) => forwardKinematics(model, jointState, { chainId, basePose: options.basePose }));
    return configuredSamples.flatMap((sample) => {
      const frame = rendererFk?.frames[sample.frameId]
        || chainFks.find((fk) => fk.frames[sample.frameId])?.frames[sample.frameId];
      return frame ? [{ ...sample, pointMm: transformPoint(frame, sample.localPointMm) }] : [];
    });
  }
  return [];
}

export function sampleContactGeometry(model, jointState = {}, options = {}) {
  const configured = options.bodyIds?.length
    ? model.contactGeometrySamples?.filter((sample) => options.bodyIds.some((bodyId) => String(sample.id).includes(bodyId)))
    : model.contactGeometrySamples;
  return sampleGeometryInWorld(model, configured, jointState, options);
}

export function sampleRenderedGeometry(model, jointState = {}, options = {}) {
  if (model.renderGeometrySamples?.length) {
    return sampleGeometryInWorld(model, model.renderGeometrySamples, jointState, options);
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

export function gripperContactWitnesses(model, jointState = {}, options = {}) {
  const geometry = model.configured?.commandInterface?.gripper?.contactGeometry;
  const rendererFk = geometry ? rendererForwardKinematics(model, jointState, options) : null;
  if (!geometry || !rendererFk) return null;
  const makeWitness = (configured) => {
    const frame = rendererFk.frames[configured.frameId];
    return frame ? {
      role: configured.role,
      bodyId: configured.bodyId,
      frameId: configured.frameId,
      localPointMm: [...configured.localPointMm],
      pointMm: transformPoint(frame, configured.localPointMm),
    } : null;
  };
  const fixed = makeWitness(geometry.fixedWitness);
  const moving = makeWitness(geometry.movingWitness);
  return fixed && moving ? { schema: geometry.schema, fixed, moving } : null;
}

export function validateProxyEnclosure(model, jointState = {}, options = {}) {
  const proxies = collisionGeometry(model, jointState, options);
  const samples = options.samples || sampleRenderedGeometry(model, jointState, options);
  const violations = samples.flatMap((sample) => {
    const margins = proxies.map((proxy) => ({
      proxyId: proxy.id,
      marginMm: proxy.type === "capsule"
        ? proxy.radiusMm - pointSegmentDistance(sample.pointMm, proxy.startMm, proxy.endMm)
        : Math.min(...pointInBoxCoordinates(sample.pointMm, proxy).map((value, index) => proxy.halfExtentsMm[index] - Math.abs(value)))
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
