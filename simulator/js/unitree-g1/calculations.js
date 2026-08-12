export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function lerp(from, to, t) {
  return Number(from || 0) + (Number(to || 0) - Number(from || 0)) * clamp(t, 0, 1);
}

export function easeInOut(t) {
  const n = clamp(t, 0, 1);
  return n < 0.5 ? 2 * n * n : 1 - Math.pow(-2 * n + 2, 2) / 2;
}

export function normalizeDegrees(value) {
  let next = Number(value) || 0;
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return next;
}

export function shortestAngleDegrees(from, to) {
  return normalizeDegrees((Number(to) || 0) - (Number(from) || 0));
}

export function interpolateRoot(from = {}, to = {}, t = 0) {
  const eased = easeInOut(t);
  const fromTheta = Number(from.theta) || 0;
  return {
    x: lerp(from.x, to.x, eased),
    z: lerp(from.z, to.z, eased),
    theta: normalizeDegrees(fromTheta + shortestAngleDegrees(fromTheta, to.theta) * eased)
  };
}

export function interpolateJoints(from = {}, to = {}, t = 0) {
  const eased = easeInOut(t);
  const result = { ...from };
  Object.keys(to || {}).forEach((jointId) => {
    result[jointId] = lerp(from[jointId], to[jointId], eased);
  });
  return result;
}

export function advanceRoot(root = {}, distanceM = 0, angleDeg = root.theta || 0) {
  const radians = (Number(angleDeg) || 0) * Math.PI / 180;
  return {
    x: (Number(root.x) || 0) + Number(distanceM || 0) * Math.cos(radians),
    z: (Number(root.z) || 0) + Number(distanceM || 0) * Math.sin(radians),
    theta: normalizeDegrees(root.theta)
  };
}

export function distance3(a, b) {
  if (!a || !b) return Infinity;
  const dx = Number(a.x || 0) - Number(b.x || 0);
  const dy = Number(a.y || 0) - Number(b.y || 0);
  const dz = Number(a.z || 0) - Number(b.z || 0);
  return Math.hypot(dx, dy, dz);
}

export function secondsPerStep(speed) {
  const ratio = clamp(speed, 1, 100) / 100;
  return lerp(0.92, 0.34, ratio);
}
