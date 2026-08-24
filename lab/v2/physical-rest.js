import { composeTransform, distance3, dot3, rotate3 } from "./math.js?v=20260823-physical-fidelity-3";
import { radialSurfaceRadiusAtHeight } from "./apparatus-geometry.js?v=20260823-physical-fidelity-4";

export const PHYSICAL_REST_SCHEMA = "robobuddy.physical-rest.v1";
export const OPPOSED_PINCH_SCHEMA = "robobuddy.opposed-pinch.v1";
export const WORLD_UP = Object.freeze([0, 1, 0]);
export const DEFAULT_REST_TOLERANCE = Object.freeze({
  maxTiltDeg: 2,
  maxGapMm: 2,
  maxPenetrationMm: 0.5,
  minimumEdgeMarginMm: 2,
  targetPositionToleranceMm: 12,
});

const SYNTHETIC_SUPPORT_PATTERN = /(?:registration[-_ ]?pin|rear[-_ ]?post|edge[-_ ]?tab|support[-_ ]?stick|thin[-_ ]?rod|synthetic[-_ ]?support)/i;

function finiteVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function rotationAxes(rotation) {
  return [
    [rotation[0], rotation[3], rotation[6]],
    [rotation[1], rotation[4], rotation[7]],
    [rotation[2], rotation[5], rotation[8]],
  ];
}

function normalized(value) {
  const length = Math.hypot(...value);
  return length > 1e-9 ? value.map((entry) => entry / length) : [0, 0, 0];
}

function angleDeg(a, b) {
  const cosine = Math.max(-1, Math.min(1, dot3(normalized(a), normalized(b))));
  return Math.acos(cosine) * 180 / Math.PI;
}

function fixtureProxies(definition) {
  return (definition.fixtures || []).flatMap((fixture) => {
    const proxies = Array.isArray(fixture.collisionProxies)
      ? fixture.collisionProxies
      : fixture.collisionProxy ? [fixture.collisionProxy] : [];
    return proxies.map((proxy, index) => ({ fixture, proxy, id: proxy.id || `${fixture.id}-proxy-${index + 1}` }));
  });
}

export function supportSurface(definition, surfaceId) {
  const match = fixtureProxies(definition).find((entry) => entry.id === surfaceId);
  if (!match || !["box", "annulus"].includes(match.proxy.type)) return null;
  if (match.proxy.type === "annulus") {
    return {
      ...match.proxy,
      id: match.id,
      fixtureId: match.fixture.id,
      centerMm: [...match.proxy.centerMm],
      innerRadiusMm: Number(match.proxy.innerRadiusMm),
      outerRadiusMm: Number(match.proxy.outerRadiusMm),
      topY: Number(match.proxy.topY ?? (Number(match.proxy.centerMm[1]) + Number(match.proxy.heightMm) / 2)),
    };
  }
  return {
    ...match.proxy,
    id: match.id,
    fixtureId: match.fixture.id,
    centerMm: [...match.proxy.centerMm],
    halfExtentsMm: [...match.proxy.halfExtentsMm],
    topY: Number(match.proxy.centerMm[1]) + Number(match.proxy.halfExtentsMm[1]),
  };
}

export function restPoseForFrame(item, frameId) {
  const pose = item?.physicalRest?.poses?.[frameId];
  if (!pose) return null;
  return {
    frameId,
    surfaceId: pose.surfaceId,
    positionMm: [...pose.positionMm],
    rotationMatrix: [...pose.rotationMatrix],
  };
}

export function initialObjectPose(item) {
  return restPoseForFrame(item, item.initialFrame);
}

export function objectWorldTransform(item) {
  const declared = restPoseForFrame(item, item?.currentFrame || item?.initialFrame);
  const position = finiteVector(item?.worldPositionMm, 3) ? item.worldPositionMm : declared?.positionMm;
  const rotation = finiteVector(item?.worldRotationMatrix, 9) ? item.worldRotationMatrix : declared?.rotationMatrix;
  if (!finiteVector(position, 3) || !finiteVector(rotation, 9)) return null;
  return {
    position: [...position],
    rotation: [...rotation],
  };
}

export function physicalObjectProxy(item, pose = objectWorldTransform(item)) {
  if (!pose || !finiteVector(pose.position, 3) || !finiteVector(pose.rotation, 9)) return null;
  const geometry = item.physicalRest?.geometry;
  if (!geometry || !finiteVector(geometry.centerLocalMm, 3) || !finiteVector(geometry.halfExtentsMm, 3)) return null;
  const proxy = {
    id: item.id,
    type: "box",
    centerMm: composeTransform(pose, { position: geometry.centerLocalMm, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).position,
    halfExtentsMm: [...geometry.halfExtentsMm],
    ...(geometry.footprintShape ? { footprintShape: geometry.footprintShape } : {}),
    axes: rotationAxes(pose.rotation),
  };
  if (Array.isArray(geometry.collisionParts) && geometry.collisionParts.length) {
    proxy.collisionParts = geometry.collisionParts.map((part, index) => (part.shape === "capsule" ? {
      id: `${item.id}:part-${index + 1}`,
      shape: "capsule",
      startMm: composeTransform(pose, { position: part.startLocalMm, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).position,
      endMm: composeTransform(pose, { position: part.endLocalMm, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).position,
      radiusMm: Number(part.radiusMm),
    } : {
      id: `${item.id}:part-${index + 1}`,
      type: "box",
      centerMm: composeTransform(pose, { position: part.centerLocalMm, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).position,
      halfExtentsMm: [...part.halfExtentsMm],
      ...(part.footprintShape ? { footprintShape: part.footprintShape } : {}),
      axes: rotationAxes(pose.rotation),
    }));
  }
  return proxy;
}

export function validateRestPose(definition, item, pose, frameId, overrides = {}) {
  const configured = item?.physicalRest;
  const expected = configured?.poses?.[frameId];
  const surface = expected ? supportSurface(definition, expected.surfaceId) : null;
  const tolerance = { ...DEFAULT_REST_TOLERANCE, ...(configured?.tolerance || {}), ...overrides };
  const reasons = [];
  if (!configured || configured.schema !== PHYSICAL_REST_SCHEMA) reasons.push("physical rest metadata is unavailable");
  if (!expected) reasons.push(`no declared rest pose for ${frameId}`);
  if (!surface) reasons.push(`real support surface ${expected?.surfaceId || "(missing)"} is unavailable`);
  if (!finiteVector(pose?.position, 3) || !finiteVector(pose?.rotation, 9)) reasons.push("world pose is not finite");
  if (reasons.length) return { ok: false, frameId, surfaceId: expected?.surfaceId || "", reasons };

  const proxy = physicalObjectProxy({ ...item, worldPositionMm: pose.position, worldRotationMatrix: pose.rotation }, pose);
  if (!proxy) return { ok: false, frameId, surfaceId: surface.id, reasons: ["object collision geometry is unavailable"] };
  const localNormal = configured.localUp || WORLD_UP;
  const worldNormal = rotate3(pose.rotation, localNormal);
  const tiltDeg = angleDeg(worldNormal, WORLD_UP);
  const verticalRadius = proxy.axes.reduce((sum, axis, index) => sum + Math.abs(axis[1]) * proxy.halfExtentsMm[index], 0);
  const bottomY = proxy.centerMm[1] - verticalRadius;
  const gapMm = bottomY - surface.topY;
  const projectionRadiusX = proxy.axes.reduce((sum, axis, index) => sum + Math.abs(axis[0]) * proxy.halfExtentsMm[index], 0);
  const projectionRadiusZ = proxy.axes.reduce((sum, axis, index) => sum + Math.abs(axis[2]) * proxy.halfExtentsMm[index], 0);
  const comLocal = configured.centerOfMassLocalMm || configured.geometry.centerLocalMm;
  const centerOfMass = composeTransform(pose, { position: comLocal, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).position;
  const radialOffsetMm = Math.hypot(centerOfMass[0] - surface.centerMm[0], centerOfMass[2] - surface.centerMm[2]);
  const minimumProjectionRadiusMm = Math.min(projectionRadiusX, projectionRadiusZ);
  const edgeMarginsMm = surface.type === "annulus"
    ? {
      // A broad ring supports a dish through distributed annular contact. The
      // centre of mass must remain inside the convex hull of that contact and
      // the dish footprint must span the real central opening.
      centerOfMassInsideOuterContact: surface.outerRadiusMm - radialOffsetMm,
      footprintSpansInnerOpening: minimumProjectionRadiusMm - surface.innerRadiusMm - radialOffsetMm,
    }
    : {
      negativeX: centerOfMass[0] - projectionRadiusX - (surface.centerMm[0] - surface.halfExtentsMm[0]),
      positiveX: surface.centerMm[0] + surface.halfExtentsMm[0] - (centerOfMass[0] + projectionRadiusX),
      negativeZ: centerOfMass[2] - projectionRadiusZ - (surface.centerMm[2] - surface.halfExtentsMm[2]),
      positiveZ: surface.centerMm[2] + surface.halfExtentsMm[2] - (centerOfMass[2] + projectionRadiusZ),
    };
  const fullFootprintMarginMm = Math.min(...Object.values(edgeMarginsMm));
  const centerOfMassMarginsMm = surface.type === "box" ? {
    negativeX: centerOfMass[0] - (surface.centerMm[0] - surface.halfExtentsMm[0]),
    positiveX: surface.centerMm[0] + surface.halfExtentsMm[0] - centerOfMass[0],
    negativeZ: centerOfMass[2] - (surface.centerMm[2] - surface.halfExtentsMm[2]),
    positiveZ: surface.centerMm[2] + surface.halfExtentsMm[2] - centerOfMass[2],
  } : edgeMarginsMm;
  const supportPolicy = configured.supportPolicy || { mode: "full_footprint" };
  const overlapX = surface.type === "box" ? Math.max(0, Math.min(proxy.centerMm[0] + projectionRadiusX, surface.centerMm[0] + surface.halfExtentsMm[0]) - Math.max(proxy.centerMm[0] - projectionRadiusX, surface.centerMm[0] - surface.halfExtentsMm[0])) : projectionRadiusX * 2;
  const overlapZ = surface.type === "box" ? Math.max(0, Math.min(proxy.centerMm[2] + projectionRadiusZ, surface.centerMm[2] + surface.halfExtentsMm[2]) - Math.max(proxy.centerMm[2] - projectionRadiusZ, surface.centerMm[2] - surface.halfExtentsMm[2])) : projectionRadiusZ * 2;
  const supportedFraction = (overlapX * overlapZ) / Math.max(1e-9, (projectionRadiusX * 2) * (projectionRadiusZ * 2));
  const minimumMarginMm = supportPolicy.mode === "center_of_mass_projection"
    ? Math.min(...Object.values(centerOfMassMarginsMm))
    : fullFootprintMarginMm;
  const targetPositionErrorMm = distance3(pose.position, expected.positionMm);
  if (tiltDeg > tolerance.maxTiltDeg) reasons.push(`tilt ${tiltDeg.toFixed(3)} deg exceeds ${tolerance.maxTiltDeg} deg`);
  if (gapMm > tolerance.maxGapMm) reasons.push(`support gap ${gapMm.toFixed(3)} mm exceeds ${tolerance.maxGapMm} mm`);
  if (gapMm < -tolerance.maxPenetrationMm) reasons.push(`surface penetration ${(-gapMm).toFixed(3)} mm exceeds ${tolerance.maxPenetrationMm} mm`);
  if (minimumMarginMm < tolerance.minimumEdgeMarginMm) reasons.push(`support footprint margin ${minimumMarginMm.toFixed(3)} mm is below ${tolerance.minimumEdgeMarginMm} mm`);
  if (supportPolicy.mode === "center_of_mass_projection" && supportedFraction < Number(supportPolicy.minimumSupportedFraction ?? 0.7)) reasons.push(`supported footprint fraction ${supportedFraction.toFixed(3)} is below ${Number(supportPolicy.minimumSupportedFraction ?? 0.7).toFixed(3)}`);
  if (targetPositionErrorMm > tolerance.targetPositionToleranceMm) reasons.push(`release position error ${targetPositionErrorMm.toFixed(3)} mm exceeds ${tolerance.targetPositionToleranceMm} mm`);
  return {
    ok: reasons.length === 0,
    frameId,
    surfaceId: surface.id,
    reasons,
    tiltDeg,
    gapMm,
    bottomY,
    supportTopY: surface.topY,
    edgeMarginsMm,
    centerOfMassMarginsMm,
    supportedFraction,
    minimumMarginMm,
    targetPositionErrorMm,
    centerOfMass,
    radialOffsetMm,
    proxy,
  };
}

export function validatePhysicalRestDefinition(definition) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  fixtureProxies(definition).forEach(({ fixture, proxy, id }) => {
    const text = `${fixture.id} ${fixture.type || ""} ${fixture.label || ""} ${id} ${proxy.provenance || ""}`;
    if (SYNTHETIC_SUPPORT_PATTERN.test(text)) add(`fixtures.${fixture.id}`, "synthetic support sticks, posts, tabs, or registration pins are forbidden");
    if (proxy.planningRole === "contact_support" && fixture.sourceBackedHolder !== true) add(`fixtures.${fixture.id}.${id}`, "contact-support geometry requires an explicit source-backed real holder");
    if (proxy.type === "annulus") {
      if (fixture.sourceBackedHolder !== true) add(`fixtures.${fixture.id}.${id}`, "annular support geometry requires an explicit source-backed real holder");
      if (!finiteVector(proxy.centerMm, 3) || !Number.isFinite(proxy.innerRadiusMm) || !Number.isFinite(proxy.outerRadiusMm)
        || proxy.innerRadiusMm <= 0 || proxy.outerRadiusMm <= proxy.innerRadiusMm || !Number.isFinite(proxy.heightMm) || proxy.heightMm <= 0) {
        add(`fixtures.${fixture.id}.${id}`, "annular support must declare a finite center, positive height, and ordered inner/outer radii");
      }
    }
  });
  (definition.objects || []).filter((item) => item.transportable !== false).forEach((item) => {
    const rest = item.physicalRest;
    if (!rest || rest.schema !== PHYSICAL_REST_SCHEMA) {
      add(`objects.${item.id}.physicalRest`, `must equal ${PHYSICAL_REST_SCHEMA}`);
      return;
    }
    if (!finiteVector(rest.gripSocketMm, 3)) add(`objects.${item.id}.physicalRest.gripSocketMm`, "must be a finite local grip socket");
    if (!finiteVector(rest.geometry?.centerLocalMm, 3) || !finiteVector(rest.geometry?.halfExtentsMm, 3)) add(`objects.${item.id}.physicalRest.geometry`, "must declare finite configured collision geometry");
    if (!finiteVector(rest.localUp, 3)) add(`objects.${item.id}.physicalRest.localUp`, "must declare the object's local up/normal axis");
    if (definition.robotId === "so101_follower") {
      const grasp = (definition.grasps || []).find((entry) => entry.objectId === item.id);
      const contact = grasp?.physicalContact;
      const contactPath = `grasps.${grasp?.id || item.id}.physicalContact`;
      if (!grasp) {
        add(`objects.${item.id}`, "SO-101 transportable apparatus must declare one configured grasp");
      } else if (!contact || contact.schema !== OPPOSED_PINCH_SCHEMA) {
        add(contactPath, `must equal ${OPPOSED_PINCH_SCHEMA}`);
      } else {
        if (!finiteVector(contact.axisLocal, 3) || Math.abs(Math.hypot(...contact.axisLocal) - 1) > 1e-6) add(`${contactPath}.axisLocal`, "must be a finite unit pinch axis");
        if (!finiteVector(contact.bandCenterLocalMm, 3) || !finiteVector(contact.bandHalfExtentsMm, 3) || contact.bandHalfExtentsMm.some((value) => value <= 0)) add(`${contactPath}.bandHalfExtentsMm`, "must declare a finite positive intended contact band");
        const contactHalfExtentMm = Number(contact.contactHalfExtentMm);
        const maximumHalfExtentMm = Number(rest.geometry?.halfExtentsMm?.[0]);
        if (!Number.isFinite(contactHalfExtentMm) || contactHalfExtentMm <= 0 || contactHalfExtentMm > maximumHalfExtentMm) add(`${contactPath}.contactHalfExtentMm`, "must declare a positive grasp cross-section no wider than the complete apparatus envelope");
        if (Array.isArray(rest.geometry?.radialProfileMm)) {
          const rendererRadiusMm = radialSurfaceRadiusAtHeight(rest.geometry.radialProfileMm, Number(contact.bandCenterLocalMm?.[1]));
          if (!Number.isFinite(rendererRadiusMm) || Math.abs(contactHalfExtentMm - rendererRadiusMm) > 0.5) add(`${contactPath}.contactHalfExtentMm`, "must match the shared rendered radial surface at the grip height within 0.5 mm");
        }
        const expectedThicknessMm = contactHalfExtentMm * 2;
        if (!Number.isFinite(contact.capturedThicknessMm) || Math.abs(contact.capturedThicknessMm - expectedThicknessMm) > 0.5) add(`${contactPath}.capturedThicknessMm`, "must match the configured apparatus cross-section at the grip band within 0.5 mm");
        if (!Number.isFinite(contact.contactToleranceMm) || contact.contactToleranceMm <= 0) add(`${contactPath}.contactToleranceMm`, "must be finite and positive");
        if (!Number.isFinite(contact.maxPenetrationMm) || contact.maxPenetrationMm < 0 || contact.maxPenetrationMm > 1) add(`${contactPath}.maxPenetrationMm`, "must limit rendered jaw penetration to at most 1 mm");
        if (!Number.isFinite(contact.alignmentToleranceDeg) || contact.alignmentToleranceDeg <= 0 || contact.alignmentToleranceDeg > 14) add(`${contactPath}.alignmentToleranceDeg`, "must limit pinch-axis misalignment to at most 14 degrees");
        if (contact.fixedFaceSign !== 1 || contact.movingFaceSign !== -1) add(contactPath, "must require the fixed and moving witnesses on opposite configured faces");
        if (!finiteVector(contact.toolAxisTargetWorld, 3)) add(`${contactPath}.toolAxisTargetWorld`, "must declare the intended world pinch direction");
        const expectedBodies = [contact.fixedBodyId, contact.movingBodyId];
        if (expectedBodies.some((bodyId) => typeof bodyId !== "string" || !bodyId)
          || !Array.isArray(grasp.allowedRobotContactBodies)
          || grasp.allowedRobotContactBodies.length !== 2
          || expectedBodies.some((bodyId) => !grasp.allowedRobotContactBodies.includes(bodyId))) {
          add(`grasps.${grasp.id}.allowedRobotContactBodies`, "must contain exactly the configured fixed-jaw and moving-jaw contact bodies");
        }
      }
    }
    const poseEntries = Object.entries(rest.poses || {});
    if (!poseEntries.some(([frameId]) => frameId === item.initialFrame)) add(`objects.${item.id}.physicalRest.poses`, "must include the initial frame");
    if (poseEntries.length < 2) add(`objects.${item.id}.physicalRest.poses`, "must include initial and final stable rest poses");
    poseEntries.forEach(([frameId, pose]) => {
      if (!definition.frames?.[frameId]) add(`objects.${item.id}.physicalRest.poses.${frameId}`, "must name an existing semantic frame");
      if (!supportSurface(definition, pose.surfaceId)) add(`objects.${item.id}.physicalRest.poses.${frameId}.surfaceId`, "must name a real box or annular support surface");
      if (!finiteVector(pose.positionMm, 3) || !finiteVector(pose.rotationMatrix, 9)) add(`objects.${item.id}.physicalRest.poses.${frameId}`, "must declare a finite object world pose");
      const report = validateRestPose(definition, item, { position: pose.positionMm, rotation: pose.rotationMatrix }, frameId);
      report.reasons?.forEach((message) => add(`objects.${item.id}.physicalRest.poses.${frameId}`, message));
      const graspFrameId = pose.graspFrameId || frameId;
      const graspFrame = definition.frames?.[graspFrameId];
      if (graspFrame && finiteVector(rest.gripSocketMm, 3) && finiteVector(pose.rotationMatrix, 9)) {
        const expectedGrip = composeTransform(
          { position: pose.positionMm, rotation: pose.rotationMatrix },
          { position: rest.gripSocketMm, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }
        ).position;
        if (distance3(expectedGrip, graspFrame.positionMm) > 0.5) add(`objects.${item.id}.physicalRest.poses.${frameId}.graspFrameId`, "grasp frame must coincide with the transformed real grip socket within 0.5 mm");
      }
    });
  });
  return { ok: errors.length === 0, errors };
}
