export const EPSILON = 1e-9;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

export function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(value, scalar) {
  return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

export function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

export function norm3(value) {
  return Math.hypot(value[0], value[1], value[2]);
}

export function normalize3(value) {
  const length = norm3(value);
  return length <= EPSILON ? [0, 0, 0] : scale3(value, 1 / length);
}

export function distance3(a, b) {
  return norm3(sub3(a, b));
}

export function identityTransform() {
  return { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], position: [0, 0, 0] };
}

export function rotationFromAxisAngle(axis, radians) {
  const [x, y, z] = normalize3(axis);
  if (Math.abs(radians) <= EPSILON || norm3([x, y, z]) <= EPSILON) return identityTransform().rotation;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c
  ];
}

export function rotationFromQuaternion(quaternion = [0, 0, 0, 1]) {
  const [rawX, rawY, rawZ, rawW] = quaternion.map(Number);
  const length = Math.hypot(rawX, rawY, rawZ, rawW) || 1;
  const x = rawX / length;
  const y = rawY / length;
  const z = rawZ / length;
  const w = rawW / length;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)
  ];
}

export function multiplyRotation(a, b) {
  const out = new Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      out[row * 3 + column] = [0, 1, 2].reduce((sum, index) => sum + a[row * 3 + index] * b[index * 3 + column], 0);
    }
  }
  return out;
}

export function rotate3(rotation, point) {
  return [
    rotation[0] * point[0] + rotation[1] * point[1] + rotation[2] * point[2],
    rotation[3] * point[0] + rotation[4] * point[1] + rotation[5] * point[2],
    rotation[6] * point[0] + rotation[7] * point[1] + rotation[8] * point[2]
  ];
}

export function composeTransform(parent, child) {
  return {
    rotation: multiplyRotation(parent.rotation, child.rotation),
    position: add3(parent.position, rotate3(parent.rotation, child.position))
  };
}

export function transformPoint(transform, point) {
  return add3(transform.position, rotate3(transform.rotation, point));
}

export function jointTransform(pivotMm, axis, radians, baseQuat = [0, 0, 0, 1]) {
  return {
    position: [...pivotMm],
    rotation: multiplyRotation(rotationFromQuaternion(baseQuat), rotationFromAxisAngle(axis, radians))
  };
}

export function seededRandom(seed = 1) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) <= EPSILON) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row) => row[size]);
}

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
