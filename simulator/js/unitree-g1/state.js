export function cloneG1(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createHumanoidRoot(value = {}) {
  return {
    x: finite(value.x, 0),
    z: finite(value.z, 0),
    theta: normalizeDegrees(finite(value.theta, 0))
  };
}

export function createHumanoidMotion(value = {}) {
  return {
    active: Boolean(value.active),
    id: String(value.id || ""),
    phase: String(value.phase || "idle"),
    progress: clamp(finite(value.progress, 0), 0, 1),
    durationSeconds: Math.max(0, finite(value.durationSeconds, 0)),
    startedAtMs: Math.max(0, finite(value.startedAtMs, 0)),
    cancellationId: Math.max(0, Math.round(finite(value.cancellationId, 0)))
  };
}

export function createEndEffectorState(value = {}) {
  return {
    left_hand: { heldObjectId: stringOrEmpty(value.left_hand && value.left_hand.heldObjectId) },
    right_hand: { heldObjectId: stringOrEmpty(value.right_hand && value.right_hand.heldObjectId) }
  };
}

function finite(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDegrees(value) {
  let next = Number(value) || 0;
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return next;
}


\n