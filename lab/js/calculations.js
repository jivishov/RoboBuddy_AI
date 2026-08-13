export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function distance3(a = [0, 0, 0], b = [0, 0, 0]) {
  const dx = Number(a[0] || 0) - Number(b[0] || 0);
  const dy = Number(a[1] || 0) - Number(b[1] || 0);
  const dz = Number(a[2] || 0) - Number(b[2] || 0);
  return Math.hypot(dx, dy, dz);
}

export function approximatelyEqual(a, b, tolerance = 0.001) {
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

export function jointPoseMatches(actual = {}, expected = {}, tolerance = 2.5) {
  const entries = Object.entries(expected || {});
  return entries.length > 0 && entries.every(([jointId, value]) => approximatelyEqual(actual[jointId], value, tolerance));
}

export function snakeToCamel(value) {
  return String(value).replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function commandSubsetMatches(actual, expected) {
  if (!actual || !expected || actual.type !== expected.type) return false;
  const keys = ["objectId", "targetId", "zoneId", "controlId", "mode", "instrumentId", "fieldId", "hand", "effector"];
  return keys.every((key) => expected[key] === undefined || actual[key] === expected[key]);
}

export function normalizeDegrees(value) {
  let next = Number(value) || 0;
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return next;
}

export function planarDistanceMm(a = [0, 0, 0], b = [0, 0, 0]) {
  return Math.hypot(Number(a[0] || 0) - Number(b[0] || 0), Number(a[2] || 0) - Number(b[2] || 0));
}

export function segmentIntersectsCircle(start = [0, 0, 0], end = [0, 0, 0], center = [0, 0, 0], radiusMm = 0) {
  const ax = Number(start[0] || 0);
  const az = Number(start[2] || 0);
  const bx = Number(end[0] || 0);
  const bz = Number(end[2] || 0);
  const cx = Number(center[0] || 0);
  const cz = Number(center[2] || 0);
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / lengthSquared)) : 0;
  return Math.hypot(ax + t * dx - cx, az + t * dz - cz) < Number(radiusMm || 0);
}
