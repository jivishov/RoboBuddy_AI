import {
  boundedMeasurement,
  eventOccursBefore,
  objectAxisCoordinateMm,
  objectAxisDistanceMm,
  objectPlanarDistanceMm,
  objectPlanarOffsetMm,
} from "./measurement.js?v=20260827-complex-lab-1";

function valueAt(state, path) {
  return String(path || "").split(".").filter(Boolean).reduce((value, key) => value?.[key], state);
}

function eventIndex(events, predicate) {
  return events.findIndex((event) => Object.entries(predicate).every(([key, value]) => event[key] === value));
}

export function evaluatePredicate(state, predicate) {
  const op = predicate.op;
  if (op === "equal") return valueAt(state, predicate.path) === predicate.value;
  if (op === "not_equal") return valueAt(state, predicate.path) !== predicate.value;
  if (op === "truthy") return Boolean(valueAt(state, predicate.path));
  if (op === "object_at") return state.objects?.[predicate.objectId]?.currentFrame === predicate.frameId && !state.objects?.[predicate.objectId]?.attachedTo;
  if (op === "attached_to") return state.objects?.[predicate.objectId]?.attachedTo === predicate.effector;
  if (op === "process_state") return state.processes?.[predicate.processId]?.state === predicate.value;
  if (op === "frame_visited") return (state.visitedFrames || []).includes(predicate.frameId);
  if (op === "event") return eventIndex(state.eventLog || [], predicate.match || {}) >= 0;
  if (op === "event_before") return eventOccursBefore(state.eventLog || [], predicate.before || {}, predicate.after || {});
  if (op === "object_axis_coordinate") return boundedMeasurement(
    objectAxisCoordinateMm(state, predicate.objectId, predicate.axis, predicate.originMm || [0, 0, 0]),
    predicate.minMm,
    predicate.maxMm,
  );
  if (op === "object_axis_distance") return boundedMeasurement(
    objectAxisDistanceMm(state, predicate.objectA, predicate.objectB, predicate.axis),
    predicate.minMm,
    predicate.maxMm,
  );
  if (op === "object_planar_distance") return boundedMeasurement(
    objectPlanarDistanceMm(state, predicate.objectA, predicate.objectB, predicate.plane || "xz"),
    predicate.minMm,
    predicate.maxMm,
  );
  if (op === "object_planar_offset") return boundedMeasurement(
    objectPlanarOffsetMm(state, predicate.objectId, predicate.originMm, predicate.plane || "xz"),
    predicate.minMm,
    predicate.maxMm,
  );
  if (op === "evidence") return (state.evidence || []).some((entry) => entry.requirementId === predicate.requirementId && String(entry.value || "").trim());
  if (op === "all") return (predicate.predicates || []).every((item) => evaluatePredicate(state, item));
  if (op === "any") return (predicate.predicates || []).some((item) => evaluatePredicate(state, item));
  if (op === "not") return !evaluatePredicate(state, predicate.predicate);
  return false;
}

export function describePredicate(predicate) {
  if (!predicate || typeof predicate !== "object") return "an unknown prerequisite";
  const value = JSON.stringify(predicate.value);
  if (predicate.op === "equal") return `${predicate.path} must equal ${value}`;
  if (predicate.op === "not_equal") return `${predicate.path} must not equal ${value}`;
  if (predicate.op === "truthy") return `${predicate.path} must be present`;
  if (predicate.op === "object_at") return `${predicate.objectId} must be placed at ${predicate.frameId}`;
  if (predicate.op === "attached_to") return `${predicate.objectId} must be attached to ${predicate.effector}`;
  if (predicate.op === "process_state") return `${predicate.processId} must be in state ${predicate.value}`;
  if (predicate.op === "frame_visited") return `frame ${predicate.frameId} must be visited`;
  if (predicate.op === "event") {
    const details = Object.entries(predicate.match || {}).map(([key, item]) => `${key}=${item}`).join(", ");
    return `event ${details || "matching the configured condition"} must occur`;
  }
  if (predicate.op === "event_before") {
    const before = Object.entries(predicate.before || {}).map(([key, item]) => `${key}=${item}`).join(", ");
    const after = Object.entries(predicate.after || {}).map(([key, item]) => `${key}=${item}`).join(", ");
    return `event ${before || "first condition"} must occur before event ${after || "second condition"}`;
  }
  if (predicate.op === "object_axis_coordinate") return `${predicate.objectId} ${predicate.axis}-coordinate from the configured ruler datum must remain within ${predicate.minMm ?? "-infinity"} to ${predicate.maxMm ?? "infinity"} mm`;
  if (predicate.op === "object_axis_distance") return `${predicate.objectA} and ${predicate.objectB} must remain ${predicate.minMm ?? 0} to ${predicate.maxMm ?? "infinity"} mm apart on the ${predicate.axis}-axis`;
  if (predicate.op === "object_planar_distance") return `${predicate.objectA} and ${predicate.objectB} must remain ${predicate.minMm ?? 0} to ${predicate.maxMm ?? "infinity"} mm apart in the ${predicate.plane || "xz"} plane`;
  if (predicate.op === "object_planar_offset") return `${predicate.objectId} must remain ${predicate.minMm ?? 0} to ${predicate.maxMm ?? "infinity"} mm from the configured datum in the ${predicate.plane || "xz"} plane`;
  if (predicate.op === "evidence") return `evidence ${predicate.requirementId} must be recorded`;
  if (predicate.op === "all") return `all of: ${(predicate.predicates || []).map(describePredicate).join("; ")}`;
  if (predicate.op === "any") return `at least one of: ${(predicate.predicates || []).map(describePredicate).join("; ")}`;
  if (predicate.op === "not") return `not (${describePredicate(predicate.predicate)})`;
  return `unsupported prerequisite operation ${predicate.op || "unknown"}`;
}

export function causalViolations(state) {
  const events = state.eventLog || [];
  const violations = [];
  events.forEach((event, index) => {
    if (event.type === "ATTACH_OBJECT") {
      const contact = events.slice(0, index).findLast((prior) => prior.type === "CONTACT" && prior.objectId === event.objectId);
      if (!contact) violations.push({ code: "ATTACH_BEFORE_CONTACT", eventIndex: index, objectId: event.objectId });
    }
    if (event.type === "PROCESS_COMMIT") {
      const contact = events.slice(0, index).findLast((prior) => prior.type === "PROCESS_CONTACT" && prior.processId === event.processId);
      if (!contact) violations.push({ code: "PROCESS_BEFORE_CONTACT", eventIndex: index, processId: event.processId });
    }
  });
  if (state.fixedRootViolation) violations.push({ code: "FIXED_ROOT_MOVED" });
  return violations;
}

export function evaluateEvidenceRequirement(state, requirement, entry) {
  if (!entry || String(entry.value ?? "").trim().length < Math.max(1, Number(requirement.minLength || 1))) return false;
  if (Array.isArray(requirement.allowedValues) && !requirement.allowedValues.map(String).includes(String(entry.value))) return false;
  if (requirement.valuePattern) {
    try { if (!new RegExp(requirement.valuePattern, "i").test(String(entry.value))) return false; }
    catch { return false; }
  }
  if (requirement.availableWhen && !evaluatePredicate(state, requirement.availableWhen)) return false;
  if (requirement.requiresEvent && eventIndex(state.eventLog || [], requirement.requiresEvent) < 0) return false;
  return true;
}

export function evaluateHiddenGradingRequirement(state, requirement) {
  if (requirement.availableWhen && !evaluatePredicate(state, requirement.availableWhen)) return false;
  if (requirement.requiresEvent && eventIndex(state.eventLog || [], requirement.requiresEvent) < 0) return false;
  return Boolean(requirement.availableWhen || requirement.requiresEvent);
}

export function gradeScenario(definition, state) {
  const goals = (definition.goalPredicates || []).map((predicate, index) => ({ id: predicate.id || `goal-${index + 1}`, passed: evaluatePredicate(state, predicate), predicate }));
  const prohibited = (definition.prohibitedStates || []).map((predicate, index) => ({ id: predicate.id || `prohibited-${index + 1}`, triggered: evaluatePredicate(state, predicate), predicate }));
  const evidence = (definition.evidenceRequirements || []).map((requirement) => ({
    id: requirement.id,
    passed: (state.evidence || []).some((entry) => entry.requirementId === requirement.id && evaluateEvidenceRequirement(state, requirement, entry)),
    requirement
  }));
  const hidden = (definition.hiddenGradingRequirements || []).map((requirement) => ({
    id: requirement.id,
    passed: evaluateHiddenGradingRequirement(state, requirement),
    requirement
  }));
  const causal = causalViolations(state);
  const passed = goals.every((item) => item.passed) && prohibited.every((item) => !item.triggered) && evidence.every((item) => item.passed) && hidden.every((item) => item.passed) && causal.length === 0;
  return { passed, goals, prohibited, evidence, hidden, causal, code: passed ? "OUTCOME_AND_EVIDENCE_COMPLETE" : "OUTCOME_OR_EVIDENCE_INCOMPLETE" };
}
