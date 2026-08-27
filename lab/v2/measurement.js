const AXIS_INDEX = Object.freeze({ x: 0, y: 1, z: 2 });
const PLANE_AXES = Object.freeze({ xy: [0, 1], xz: [0, 2], yz: [1, 2] });

function finiteVector(value, length = 3) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

export function measurementAxisIndex(axis) {
  const index = AXIS_INDEX[String(axis || "").toLowerCase()];
  return Number.isInteger(index) ? index : null;
}

export function measurementPlaneAxes(plane = "xz") {
  const axes = PLANE_AXES[String(plane || "xz").toLowerCase()];
  return axes ? [...axes] : null;
}

export function objectPositionMm(state, objectId) {
  const object = state?.objects?.[objectId];
  if (!finiteVector(object?.worldPositionMm)) return null;
  return object.worldPositionMm.map(Number);
}

export function objectAxisCoordinateMm(state, objectId, axis, originMm = [0, 0, 0]) {
  const position = objectPositionMm(state, objectId);
  const index = measurementAxisIndex(axis);
  if (!position || index === null || !finiteVector(originMm)) return null;
  return position[index] - Number(originMm[index]);
}

export function objectAxisDistanceMm(state, objectA, objectB, axis) {
  const a = objectPositionMm(state, objectA);
  const b = objectPositionMm(state, objectB);
  const index = measurementAxisIndex(axis);
  if (!a || !b || index === null) return null;
  return Math.abs(a[index] - b[index]);
}

export function objectPlanarDistanceMm(state, objectA, objectB, plane = "xz") {
  const a = objectPositionMm(state, objectA);
  const b = objectPositionMm(state, objectB);
  const axes = measurementPlaneAxes(plane);
  if (!a || !b || !axes) return null;
  return Math.hypot(...axes.map((axis) => a[axis] - b[axis]));
}

export function objectPlanarOffsetMm(state, objectId, originMm, plane = "xz") {
  const position = objectPositionMm(state, objectId);
  const axes = measurementPlaneAxes(plane);
  if (!position || !finiteVector(originMm) || !axes) return null;
  return Math.hypot(...axes.map((axis) => position[axis] - Number(originMm[axis])));
}

export function eventMatches(event, match = {}) {
  return Boolean(event) && Object.entries(match || {}).every(([key, value]) => event[key] === value);
}

export function firstMatchingEventIndex(events, match = {}) {
  return Array.isArray(events) ? events.findIndex((event) => eventMatches(event, match)) : -1;
}

export function eventOccursBefore(events, beforeMatch, afterMatch) {
  const before = firstMatchingEventIndex(events, beforeMatch);
  const after = firstMatchingEventIndex(events, afterMatch);
  return before >= 0 && after >= 0 && before < after;
}

export function boundedMeasurement(value, minimum, maximum) {
  if (!Number.isFinite(value)) return false;
  if (Number.isFinite(minimum) && value < Number(minimum) - 1e-9) return false;
  if (Number.isFinite(maximum) && value > Number(maximum) + 1e-9) return false;
  return true;
}

export function validateMeasurementFixture(fixture) {
  const measurement = fixture?.measurement;
  const errors = [];
  if (fixture?.type !== "configured_measurement_ruler") errors.push("fixture type must be configured_measurement_ruler");
  if (!finiteVector(measurement?.originMm)) errors.push("measurement.originMm must be a finite xyz vector");
  if (measurementAxisIndex(measurement?.axis) === null) errors.push("measurement.axis must be x, y, or z");
  if (!Number.isFinite(measurement?.lengthMm) || Number(measurement.lengthMm) <= 0) errors.push("measurement.lengthMm must be positive");
  if (!Number.isFinite(measurement?.minorTickMm) || Number(measurement.minorTickMm) <= 0) errors.push("measurement.minorTickMm must be positive");
  if (!Number.isFinite(measurement?.majorTickMm) || Number(measurement.majorTickMm) < Number(measurement.minorTickMm || 0)) errors.push("measurement.majorTickMm must be at least the minor tick interval");
  if (Number.isFinite(measurement?.lengthMm) && Number.isFinite(measurement?.minorTickMm)
    && Number(measurement.lengthMm) / Number(measurement.minorTickMm) > 250) errors.push("measurement ruler may render at most 250 minor intervals");
  return { ok: errors.length === 0, errors };
}

const MEASURED_PREDICATE_OPS = new Set([
  "event_before",
  "object_axis_coordinate",
  "object_axis_distance",
  "object_planar_distance",
  "object_planar_offset",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateBounds(predicate, errors) {
  if (predicate.minMm !== undefined && !Number.isFinite(predicate.minMm)) errors.push("minMm must be finite when provided");
  if (predicate.maxMm !== undefined && !Number.isFinite(predicate.maxMm)) errors.push("maxMm must be finite when provided");
  if (Number.isFinite(predicate.minMm) && Number.isFinite(predicate.maxMm) && Number(predicate.minMm) > Number(predicate.maxMm)) {
    errors.push("minMm must not exceed maxMm");
  }
}

export function validateMeasurementPredicate(predicate) {
  const errors = [];
  if (!predicate || typeof predicate !== "object" || Array.isArray(predicate)) return { ok: true, errors };
  const op = String(predicate.op || "");
  if (!MEASURED_PREDICATE_OPS.has(op)) return { ok: true, errors };
  if (op === "event_before") {
    if (!predicate.before || typeof predicate.before !== "object" || Array.isArray(predicate.before) || !Object.keys(predicate.before).length) errors.push("event_before.before must be a non-empty event match object");
    if (!predicate.after || typeof predicate.after !== "object" || Array.isArray(predicate.after) || !Object.keys(predicate.after).length) errors.push("event_before.after must be a non-empty event match object");
    return { ok: errors.length === 0, errors };
  }
  validateBounds(predicate, errors);
  if (["object_axis_coordinate", "object_planar_offset"].includes(op) && !nonEmptyString(predicate.objectId)) errors.push(`${op}.objectId must be non-empty`);
  if (["object_axis_distance", "object_planar_distance"].includes(op)) {
    if (!nonEmptyString(predicate.objectA)) errors.push(`${op}.objectA must be non-empty`);
    if (!nonEmptyString(predicate.objectB)) errors.push(`${op}.objectB must be non-empty`);
    if (predicate.objectA === predicate.objectB) errors.push(`${op} requires two distinct objects`);
  }
  if (["object_axis_coordinate", "object_axis_distance"].includes(op) && measurementAxisIndex(predicate.axis) === null) errors.push(`${op}.axis must be x, y, or z`);
  if (["object_planar_distance", "object_planar_offset"].includes(op) && !measurementPlaneAxes(predicate.plane || "xz")) errors.push(`${op}.plane must be xy, xz, or yz`);
  if (["object_axis_coordinate", "object_planar_offset"].includes(op) && !finiteVector(predicate.originMm)) errors.push(`${op}.originMm must be a finite xyz vector`);
  return { ok: errors.length === 0, errors };
}
