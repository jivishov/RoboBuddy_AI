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
  if (op === "evidence") return (state.evidence || []).some((entry) => entry.requirementId === predicate.requirementId && String(entry.value || "").trim());
  if (op === "all") return (predicate.predicates || []).every((item) => evaluatePredicate(state, item));
  if (op === "any") return (predicate.predicates || []).some((item) => evaluatePredicate(state, item));
  if (op === "not") return !evaluatePredicate(state, predicate.predicate);
  return false;
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

export function gradeScenario(definition, state) {
  const goals = (definition.goalPredicates || []).map((predicate, index) => ({ id: predicate.id || `goal-${index + 1}`, passed: evaluatePredicate(state, predicate), predicate }));
  const prohibited = (definition.prohibitedStates || []).map((predicate, index) => ({ id: predicate.id || `prohibited-${index + 1}`, triggered: evaluatePredicate(state, predicate), predicate }));
  const evidence = (definition.evidenceRequirements || []).map((requirement) => ({
    id: requirement.id,
    passed: (state.evidence || []).some((entry) => entry.requirementId === requirement.id && String(entry.value ?? "").trim().length > 0),
    requirement
  }));
  const causal = causalViolations(state);
  const passed = goals.every((item) => item.passed) && prohibited.every((item) => !item.triggered) && evidence.every((item) => item.passed) && causal.length === 0;
  return { passed, goals, prohibited, evidence, causal, code: passed ? "OUTCOME_AND_EVIDENCE_COMPLETE" : "OUTCOME_OR_EVIDENCE_INCOMPLETE" };
}
