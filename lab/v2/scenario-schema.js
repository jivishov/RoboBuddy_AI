import { deepClone } from "./math.js?v=20260823-physical-fidelity-3";
import { validatePhysicalRestDefinition } from "./physical-rest.js?v=20260823-physical-fidelity-3";
import { validateMeasurementFixture, validateMeasurementPredicate } from "./measurement.js?v=20260827-complex-lab-1";

export const SCENARIO_V2_SCHEMA = "robobuddy.lab-scenario.v2";
export const PROVENANCE_LABELS = Object.freeze(["M", "F", "R", "C"]);
export const MIGRATION_CLASSES = Object.freeze(["A", "B", "C"]);
export const FRAME_ROLES = Object.freeze(["approach", "contact", "lift", "retreat", "destination"]);

function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function finiteVector(value, length) { return Array.isArray(value) && value.length === length && value.every(Number.isFinite); }

function validatePredicateTree(predicate, path, add) {
  if (!object(predicate)) return;
  const validation = validateMeasurementPredicate(predicate);
  validation.errors.forEach((message) => add(false, path, message));
  if (Array.isArray(predicate.predicates)) predicate.predicates.forEach((child, index) => validatePredicateTree(child, `${path}.predicates.${index}`, add));
  if (object(predicate.predicate)) validatePredicateTree(predicate.predicate, `${path}.predicate`, add);
}

export function validateScenarioV2(definition, options = {}) {
  const errors = [];
  const add = (condition, path, message) => { if (!condition) errors.push({ path, message }); };
  add(object(definition), "$", "scenario must be an object");
  if (!object(definition)) return { ok: false, errors };
  add(definition.schema === SCENARIO_V2_SCHEMA, "schema", `must equal ${SCENARIO_V2_SCHEMA}`);
  ["id", "title", "brief", "robotId", "supersedes", "assistanceLevel"].forEach((key) => add(nonEmpty(definition[key]), key, "must be a non-empty string"));
  add(Number.isInteger(definition.rank) && definition.rank >= 1 && definition.rank <= 10, "rank", "must be an integer from 1 to 10");
  add(object(definition.migration) && MIGRATION_CLASSES.includes(definition.migration?.class), "migration.class", "must be A, B, or C");
  add(nonEmpty(definition.migration?.legacyLearningObjective), "migration.legacyLearningObjective", "must preserve the legacy learning objective");
  if (definition.migration?.class === "C") add(nonEmpty(definition.migration?.redesignRationale), "migration.redesignRationale", "class C requires a redesign rationale");
  add(object(definition.canonicalModel), "canonicalModel", "must identify the canonical model");
  add(definition.canonicalModel?.id === definition.robotId, "canonicalModel.id", "must match robotId");
  add(nonEmpty(definition.canonicalModel?.sourceRevision), "canonicalModel.sourceRevision", "must state a source revision");
  add(object(definition.frames) && Object.keys(definition.frames || {}).length >= 5, "frames", "must expose named task frames");
  const roles = new Set();
  Object.entries(definition.frames || {}).forEach(([id, frame]) => {
    add(nonEmpty(id), `frames.${id}`, "frame id must be non-empty");
    add(object(frame), `frames.${id}`, "frame must be an object");
    add(finiteVector(frame.positionMm, 3), `frames.${id}.positionMm`, "must be a finite xyz vector");
    add(nonEmpty(frame.role), `frames.${id}.role`, "must state a discoverable role");
    if (frame.role) roles.add(frame.role);
    add(object(frame.tolerance) && Number.isFinite(frame.tolerance?.positionMm), `frames.${id}.tolerance`, "must include a finite position tolerance");
  });
  FRAME_ROLES.forEach((role) => add(roles.has(role), "frames", `must include a ${role} frame`));
  if (definition.robotId === "unitree_g1_29dof") {
    add(roles.has("dock"), "frames", "G1 tasks require a dock frame");
    add(roles.has("latch"), "frames", "G1 tasks require a latch frame");
  }
  ["fixtures", "objects", "grasps", "processModels", "goalPredicates", "prohibitedStates", "evidenceRequirements", "provenance"].forEach((key) => add(Array.isArray(definition[key]), key, "must be an array"));
  (definition.fixtures || []).forEach((fixture, index) => {
    add(fixture.visible === true, `fixtures.${index}.visible`, "fixture assumptions must be visible");
    if (fixture.type === "configured_measurement_ruler") {
      const measurement = validateMeasurementFixture(fixture);
      measurement.errors.forEach((message) => add(false, `fixtures.${index}.measurement`, message));
      add(fixture.presentationOnly === true, `fixtures.${index}.presentationOnly`, "measurement rulers must remain visible, non-colliding presentation aids");
    }
  });
  (definition.objects || []).forEach((item, index) => {
    add(nonEmpty(item.id), `objects.${index}.id`, "must be non-empty");
    add(nonEmpty(item.initialFrame) && Boolean(definition.frames?.[item.initialFrame]), `objects.${index}.initialFrame`, "must name an existing frame");
  });
  (definition.processModels || []).forEach((process, index) => {
    add(process.discrete === true, `processModels.${index}.discrete`, "process changes must be discrete");
    add(process.contactGated === true, `processModels.${index}.contactGated`, "process changes must be contact gated");
    add(Array.isArray(process.prerequisites), `processModels.${index}.prerequisites`, "must declare prerequisites");
  });
  add((definition.goalPredicates || []).length > 0, "goalPredicates", "must contain observable outcome predicates");
  (definition.goalPredicates || []).forEach((predicate, index) => validatePredicateTree(predicate, `goalPredicates.${index}`, add));
  (definition.prohibitedStates || []).forEach((predicate, index) => validatePredicateTree(predicate, `prohibitedStates.${index}`, add));
  (definition.processModels || []).forEach((process, processIndex) => (process.prerequisites || []).forEach((predicate, predicateIndex) => {
    validatePredicateTree(predicate, `processModels.${processIndex}.prerequisites.${predicateIndex}`, add);
  }));
  const portablePython = definition.api?.runtime === "robobuddy.portable-python.v1";
  add(portablePython || (definition.evidenceRequirements || []).length > 0, "evidenceRequirements", "must require learner evidence unless hidden authoritative portable-Python grading is declared");
  if (portablePython) {
    add(object(definition.portablePython), "portablePython", "must declare the portable Python runtime contract");
    add(definition.portablePython?.learnerGradingCalls === false, "portablePython.learnerGradingCalls", "must keep grading APIs unavailable to learner source");
    add(Array.isArray(definition.hiddenGradingRequirements) && definition.hiddenGradingRequirements.length > 0, "hiddenGradingRequirements", "must preserve prior evidence intent as at least one hidden plant/event requirement");
    (definition.hiddenGradingRequirements || []).forEach((requirement, index) => {
      add(nonEmpty(requirement.id), `hiddenGradingRequirements.${index}.id`, "must identify the hidden requirement");
      add(requirement.learnerCallable === false, `hiddenGradingRequirements.${index}.learnerCallable`, "must not expose a learner-callable grading path");
      add(requirement.authority === "plant/events", `hiddenGradingRequirements.${index}.authority`, "must name authoritative plant/events state");
      add(object(requirement.availableWhen) || object(requirement.requiresEvent), `hiddenGradingRequirements.${index}`, "must be gated by an authoritative predicate or event");
      if (object(requirement.availableWhen)) validatePredicateTree(requirement.availableWhen, `hiddenGradingRequirements.${index}.availableWhen`, add);
    });
  }
  if (["so101_follower", "lekiwi_sim", "openarm_v2_bimanual"].includes(definition.robotId)) {
    const physicalRest = validatePhysicalRestDefinition(definition);
    physicalRest.errors.forEach((error) => errors.push(error));
  }
  (definition.evidenceRequirements || []).forEach((requirement, index) => {
    add(nonEmpty(requirement.id), `evidenceRequirements.${index}.id`, "must identify the evidence requirement");
    add(nonEmpty(requirement.label || requirement.prompt), `evidenceRequirements.${index}.label`, "must provide a visible label or prompt");
    if (requirement.minLength !== undefined) add(Number.isInteger(requirement.minLength) && requirement.minLength > 0, `evidenceRequirements.${index}.minLength`, "must be a positive integer");
    if (requirement.allowedValues !== undefined) add(Array.isArray(requirement.allowedValues) && requirement.allowedValues.length > 0, `evidenceRequirements.${index}.allowedValues`, "must be a non-empty array");
    if (requirement.availableWhen !== undefined) {
      add(object(requirement.availableWhen), `evidenceRequirements.${index}.availableWhen`, "must be an observable predicate");
      if (object(requirement.availableWhen)) validatePredicateTree(requirement.availableWhen, `evidenceRequirements.${index}.availableWhen`, add);
    }
    if (requirement.requiresEvent !== undefined) add(object(requirement.requiresEvent), `evidenceRequirements.${index}.requiresEvent`, "must be an event match object");
  });
  (definition.provenance || []).forEach((entry, index) => {
    add(PROVENANCE_LABELS.includes(entry.label), `provenance.${index}.label`, "must be M, F, R, or C");
    add(nonEmpty(entry.claim), `provenance.${index}.claim`, "must state the bounded claim");
    if (["M", "F"].includes(entry.label)) add(nonEmpty(entry.sourceRef), `provenance.${index}.sourceRef`, "M/F claims require a source reference");
  });
  add(object(definition.modelClaim), "modelClaim", "must include a model claim");
  ["source", "joints", "frames", "limitProvenance", "collisionProxyProvenance", "supportedFidelity", "unsupportedPhysics"].forEach((key) => add(definition.modelClaim?.[key] !== undefined, `modelClaim.${key}`, "is required"));
  add(object(definition.api) && ["guided", "builder", "challenge"].includes(definition.api?.level), "api.level", "must select guided, builder, or challenge");
  if (options.requireValidation !== false) {
    add(object(definition.validation), "validation", "must include validation-only executions");
    add(Array.isArray(definition.validation?.referenceExecutions) && definition.validation.referenceExecutions.length > 0, "validation.referenceExecutions", "must include a reference execution");
    add(Array.isArray(definition.validation?.acceptedAlternates) && definition.validation.acceptedAlternates.length > 0, "validation.acceptedAlternates", "must include an accepted alternate algorithm/seed/order");
    add(Array.isArray(definition.validation?.negativeCases) && definition.validation.negativeCases.length > 0, "validation.negativeCases", "must include negative cases");
  }
  if (options.expectedRobotId) add(definition.robotId === options.expectedRobotId, "robotId", `must equal ${options.expectedRobotId}`);
  return { ok: errors.length === 0, errors };
}

export function assertScenarioV2(definition, options = {}) {
  const result = validateScenarioV2(definition, options);
  if (!result.ok) throw new Error(result.errors.map((item) => `${item.path}: ${item.message}`).join("\n"));
  return definition;
}

export function stripValidationForClient(definition) {
  const output = deepClone(definition);
  if (definition.robotId === "openarm_v2_bimanual" && definition.api?.runtime !== "robobuddy.portable-python.v1") {
    const starterCalls = definition.validation?.referenceExecutions?.[0]?.calls;
    if (Array.isArray(starterCalls) && starterCalls.length > 0) {
      output.api = { ...output.api, starterCalls: deepClone(starterCalls).map((call) => {
        const sanitized = { ...call, args: { ...(call.args || {}) } };
        if (call.method === "lab.record_evidence") sanitized.args.value = "";
        if (call.method === "skills.transport") {
          ["seed", "pathSeed", "starts", "maxIterations"].forEach((key) => delete sanitized.args[key]);
        }
        return sanitized;
      }) };
    }
  }
  delete output.validation;
  output.validationAvailable = true;
  return output;
}

export function clientScenarioPath(definition) {
  return `missions/lab-assistant/v2/generated/scenarios/${definition.id}.json`;
}
