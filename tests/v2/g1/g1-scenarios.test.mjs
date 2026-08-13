import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScenarioV2Engine,
  loadRobotModel,
  modelClaim,
  validateProxyEnclosure,
  validateScenarioV2
} from "../../../lab/v2/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FAMILY = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "g1");
const files = (await readdir(FAMILY)).filter((name) => name.endsWith(".json")).sort();
const definitions = await Promise.all(files.map(async (name) => JSON.parse(await readFile(resolve(FAMILY, name), "utf8"))));
const canonical = await loadRobotModel("unitree_g1_29dof");
const canonicalClaim = modelClaim("unitree_g1_29dof");
const expectedIds = [
  "g1-01-empty-tray",
  "g1-02-glassware-carrier",
  "g1-03-sample-carrier",
  "g1-04-filtration-carrier",
  "g1-05-titration-carrier",
  "g1-06-cooling-carrier",
  "g1-07-chromatography-carrier",
  "g1-08-spectrometer-carrier",
  "g1-09-standardization-carrier",
  "g1-10-lab-runner-shift"
];
const expectedSupersedes = [
  "g1-01-empty-tray",
  "g1-02-sealed-sample",
  "g1-03-cuvette-rack",
  "g1-04-filtration-kit",
  "g1-05-waste-carrier",
  "g1-06-cooled-sample-tray",
  "g1-07-reagent-tote",
  "g1-08-spectro-courier-loop",
  "g1-09-gravimetry-logistics",
  "g1-10-lab-runner-shift"
];

function shortestPath(edges, start, target) {
  const queue = [[start]];
  const visited = new Set([start]);
  while (queue.length) {
    const path = queue.shift();
    const node = path.at(-1);
    if (node === target) return path;
    for (const next of [...(edges[node] || [])].sort()) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...path, next]);
      }
    }
  }
  return null;
}

function requireOrdered(path, frameIds, message) {
  assert.ok(path, `${message}: route unavailable`);
  let cursor = -1;
  for (const frameId of frameIds) {
    const index = path.indexOf(frameId);
    assert.ok(index > cursor, `${message}: ${frameId} must be traversed in order (${path.join(" -> ")})`);
    cursor = index;
  }
}

function pointToSegmentDistanceMm(point, start, end) {
  const dx = end[0] - start[0];
  const dz = end[2] - start[2];
  const denominator = dx * dx + dz * dz || 1;
  const projection = ((point[0] - start[0]) * dx + (point[2] - start[2]) * dz) / denominator;
  const t = Math.max(0, Math.min(1, projection));
  return Math.hypot(point[0] - (start[0] + t * dx), point[2] - (start[2] + t * dz));
}

function firstFailure(run) {
  return run.results.find((item) => !item.ok);
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

assert.equal(definitions.length, 10, "G1 family must contain exactly ten sources");
assert.deepEqual(definitions.map((item) => item.id), expectedIds);
assert.deepEqual(definitions.map((item) => item.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.deepEqual(definitions.map((item) => item.supersedes), expectedSupersedes);
assert.equal(validateProxyEnclosure(canonical, {}).ok, true, "Frozen G1 configured proxies must enclose the available home-pose samples");

for (const definition of definitions) {
  const validation = validateScenarioV2(definition);
  assert.equal(validation.ok, true, `${definition.id}: ${validation.errors.map((item) => `${item.path}: ${item.message}`).join("\n")}`);
  assert.equal(definition.schemaVersion, 2);
  assert.equal(definition.robotId, "unitree_g1_29dof");
  assert.equal(definition.canonicalModel.sourceRevision, canonical.source.revision);
  assert.deepEqual(definition.modelClaim, canonicalClaim);
  assert.equal(definition.legacyClassification, definition.migration.class);
  assert.ok(definition.provenance.some((item) => item.label === "M" && item.sourceRef));
  assert.ok(definition.provenance.some((item) => item.label === "F" && item.sourceRef));
  assert.ok(definition.provenance.some((item) => item.label === "R"));
  assert.ok(definition.provenance.some((item) => item.label === "C"));
  assert.match(definition.navigation.motionBoundary, /no leg IK.*balance.*dynamics.*force.*payload/i);
  const operationalKeys = collectKeys({
    frames: definition.frames,
    fixtures: definition.fixtures,
    objects: definition.objects,
    grasps: definition.grasps,
    processModels: definition.processModels,
    goalPredicates: definition.goalPredicates,
    prohibitedStates: definition.prohibitedStates,
    evidenceRequirements: definition.evidenceRequirements,
    validation: definition.validation
  });
  assert.ok(operationalKeys.every((key) => !/(?:joint|\bik\b|force|torque|payload|temperature|thermal|fluid|calibration|measurement)/i.test(key)), `${definition.id}: operational data cannot hide unsupported manipulation, dynamics, or measurement controls`);
  assert.deepEqual(definition.frames.home.positionMm, [0, 0, 0]);
  assert.equal(definition.frames.home.role, "home");
  assert.equal(definition.frames.safe_transfer_hub.role, "route");
  assert.ok(Object.values(definition.frames).every((frame) => Array.isArray(frame.positionMm) && frame.positionMm.length === 3 && frame.positionMm.every(Number.isFinite) && Number.isFinite(frame.headingDeg)));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "approach"));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "contact"));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "lift" && /planar.*no arm lift|planar secured-carrier clearance/i.test(`${frame.label} ${frame.motionMeaning || ""}`)));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "destination"));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "retreat"));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "dock"));
  assert.ok(Object.values(definition.frames).some((frame) => frame.role === "latch"));
  assert.ok(definition.fixtures.every((fixture) => fixture.visible === true && definition.frames[fixture.frameId]));
  assert.ok(definition.objects.filter((item) => item.transportable).every((item) =>
    item.securedCarrier &&
    item.attachmentInterface === canonical.configured.carrierInterface &&
    item.initialState?.contentsSecured === true &&
    /secured before any loaded motion/i.test(item.initialState?.contentsStatus)
  ));
  assert.ok(definition.objects.filter((item) => !item.transportable).every((item) => !item.securedCarrier));
  for (const object of definition.objects.filter((item) => item.initialState?.teacherConfiguredReleaseAuthorization)) {
    assert.match(object.initialState.teacherConfiguredReleaseAuthorization, /visible configured simulation authorization.*no temperature or measurement implied/i);
    assert.ok(definition.fixtures.some((fixture) => fixture.type === "configured-status-marker" && fixture.visible === true), `${definition.id}/${object.id}: teacher-configured authorization must have a visible marker`);
  }
  assert.ok(definition.grasps.every((grasp) =>
    grasp.mode === "secured-carrier-latch" &&
    grasp.effector === "secured_carrier_mount" &&
    grasp.attachmentInterface === canonical.configured.carrierInterface &&
    definition.frames[grasp.approachFrame]?.role === "approach" &&
    definition.frames[grasp.contactFrame]?.role === "contact" &&
    definition.frames[grasp.latchFrame]?.role === "latch"
  ));
  assert.ok(definition.processModels.every((process) => {
    const prerequisiteOps = process.prerequisites.map((item) => item.op);
    return process.discrete &&
      process.contactGated &&
      prerequisiteOps.includes("object_at") &&
      prerequisiteOps.filter((op) => op === "frame_visited").length >= 2 &&
      prerequisiteOps.includes("event");
  }));
  assert.ok(definition.evidenceRequirements.every((item) =>
    item.availableWhen &&
    item.requiresEvent &&
    item.value === undefined &&
    item.minLength >= 20 &&
    item.valuePattern.includes("dock") &&
    item.valuePattern.includes("latch") &&
    item.valuePattern.includes("carrier")
  ));

  const edges = definition.navigation.waypointGraph.edges;
  assert.deepEqual(edges.home.filter((id) => id !== "restricted_bench"), ["safe_transfer_hub"]);
  assert.ok((edges.safe_transfer_hub || []).includes("home"));
  for (const retreat of Object.keys(definition.frames).filter((id) => definition.frames[id].role === "retreat")) {
    assert.deepEqual(edges[retreat], ["safe_transfer_hub"], `${definition.id}/${retreat}: no direct retreat-to-pickup shortcut`);
    requireOrdered(shortestPath(edges, retreat, "home"), [retreat, "safe_transfer_hub", "home"], `${definition.id}/${retreat}: return home`);
  }

  const reference = definition.validation.referenceExecutions[0];
  const alternate = definition.validation.acceptedAlternates[0];
  const validationMethods = new Set(Object.values(definition.validation).flat().flatMap((execution) => (execution.calls || []).map((call) => call.method)));
  const logisticsMethods = new Set(["skills.transport", "skills.fixture_operation", "lab.record_evidence", "robot.navigate", "robot.dock"]);
  assert.ok([...validationMethods].every((method) => logisticsMethods.has(method)), `${definition.id}: validation cannot disguise free manipulation or IK as logistics`);
  const referenceTransports = reference.calls.filter((call) => call.method === "skills.transport");
  const alternateDocks = alternate.calls.filter((call) => call.method === "robot.dock");
  assert.equal(referenceTransports.length, definition.objects.filter((item) => item.transportable).length);
  assert.equal(alternateDocks.length, referenceTransports.length);
  assert.equal(reference.calls.at(-1).method, "robot.navigate");
  assert.equal(reference.calls.at(-1).args.frameId, "home");
  assert.equal(alternate.calls.at(-1).method, "robot.navigate");
  assert.equal(alternate.calls.at(-1).args.frameId, "home");
  assert.ok(alternate.calls.some((call) => call.method === "robot.navigate" && /secondary_approach$/.test(call.args.frameId)), `${definition.id}: alternate must exercise a distinct safe approach`);
  if (referenceTransports.length > 1) {
    assert.notEqual(referenceTransports[0].args.objectId, alternateDocks[0].args.objectId, `${definition.id}: multi-carrier alternate must use a different safe order`);
  }

  for (const transport of referenceTransports) {
    const objectId = transport.args.objectId;
    const grasp = definition.grasps.find((item) => item.objectId === objectId);
    const carrierNumber = definition.grasps.indexOf(grasp) + 1;
    const pickupDock = definition.fixtures.find((item) => item.id === `pickup_dock_${carrierNumber}`)?.frameId;
    const receiverDock = definition.fixtures.find((item) => item.id === `receiver_dock_${carrierNumber}`)?.frameId;
    const receiverLatch = definition.fixtures.find((item) => item.id === `receiver_latch_${carrierNumber}`)?.frameId;
    assert.ok(pickupDock && receiverDock && receiverLatch, `${definition.id}/${objectId}: pickup and receiver dock/latch fixtures must resolve to named frames`);
    const pickupPath = shortestPath(edges, "home", transport.args.contactFrame);
    requireOrdered(pickupPath, ["home", "safe_transfer_hub", grasp.approachFrame, pickupDock, grasp.latchFrame, transport.args.contactFrame], `${definition.id}/${objectId}: pickup causality`);
    const loadedPath = shortestPath(edges, transport.args.contactFrame, transport.args.destinationFrame);
    requireOrdered(loadedPath, [transport.args.contactFrame, transport.args.liftFrame, receiverDock, receiverLatch, transport.args.destinationFrame], `${definition.id}/${objectId}: loaded route causality`);
    assert.ok(loadedPath.some((id) => /^carrier_\d+_route_\d+$/.test(id)), `${definition.id}/${objectId}: loaded route needs a named safe waypoint`);
    requireOrdered(shortestPath(edges, transport.args.destinationFrame, transport.args.retreatFrame), [transport.args.destinationFrame, transport.args.retreatFrame], `${definition.id}/${objectId}: receiver retreat`);
    assert.ok(definition.goalPredicates.some((goal) => goal.op === "truthy" && goal.path === `objects.${objectId}.state.contentsSecured`));
    assert.ok(definition.prohibitedStates.some((item) => item.op === "not" && item.predicate?.path === `objects.${objectId}.state.contentsSecured`));
  }

  const restrictedFixture = definition.fixtures.find((fixture) => fixture.type === "restricted-zone");
  if (restrictedFixture) {
    assert.equal(restrictedFixture.configured, true);
    assert.ok(Number.isFinite(restrictedFixture.clearanceRadiusMm) && restrictedFixture.clearanceRadiusMm > 0);
    const restrictedPosition = definition.frames[restrictedFixture.frameId].positionMm;
    assert.notDeepEqual(restrictedPosition, definition.frames.home.positionMm, `${definition.id}: restricted bench cannot overlap home`);
    let cursor = "home";
    for (const call of reference.calls) {
      const targets = call.method === "skills.transport"
        ? [call.args.contactFrame, call.args.destinationFrame, call.args.retreatFrame]
        : call.method === "robot.navigate" ? [call.args.frameId] : [];
      for (const target of targets) {
        const path = shortestPath(edges, cursor, target);
        assert.ok(!path.includes(restrictedFixture.frameId), `${definition.id}: success route cannot enter the restricted bench`);
        for (let index = 1; index < path.length; index += 1) {
          const distance = pointToSegmentDistanceMm(restrictedPosition, definition.frames[path[index - 1]].positionMm, definition.frames[path[index]].positionMm);
          assert.ok(distance >= restrictedFixture.clearanceRadiusMm, `${definition.id}: ${path[index - 1]} -> ${path[index]} violates configured restricted-zone clearance (${distance.toFixed(1)} mm)`);
        }
        cursor = target;
      }
    }
  }

  for (const requirement of definition.evidenceRequirements) {
    const processId = requirement.availableWhen.processId;
    for (const execution of [...definition.validation.referenceExecutions, ...definition.validation.acceptedAlternates]) {
      const processIndex = execution.calls.findIndex((call) => call.method === "skills.fixture_operation" && call.args.processId === processId);
      const evidenceIndex = execution.calls.findIndex((call) => call.method === "lab.record_evidence" && call.args.requirementId === requirement.id);
      assert.ok(processIndex >= 0 && evidenceIndex > processIndex, `${definition.id}/${execution.id}: evidence must be blank until its contacted process commits`);
    }
  }
  for (const execution of [...definition.validation.referenceExecutions, ...definition.validation.acceptedAlternates]) {
    for (const call of execution.calls.filter((item) => item.method === "skills.fixture_operation")) {
      const process = definition.processModels.find((item) => item.id === call.args.processId);
      const fixture = definition.fixtures.find((item) => item.id === call.args.fixtureId);
      assert.ok(process, `${definition.id}/${execution.id}: process call must name an authored process`);
      assert.equal(fixture?.type, "receiver-latch", `${definition.id}/${execution.id}: receiver process must make contact at a visible receiver latch`);
      assert.equal(call.args.value, process.completeState, `${definition.id}/${execution.id}: process call must commit only its declared terminal state`);
      assert.ok(process.prerequisites.some((item) => item.objectId === call.args.objectId), `${definition.id}/${execution.id}: process prerequisites must bind the delivered carrier`);
    }
  }
}

if (process.env.G1_STRUCTURAL_ONLY === "1") {
  console.log("G1 v2 structural review passed: ten sources, constrained routes, visible dock/latch frames, secured contents, gated processes/evidence, and reason-specific validation definitions.");
  process.exit(0);
}

// Compatibility is authored configuration; attachment is runtime state and
// must remain empty until the dock/contact trajectory reaches its latch event.
for (const definition of definitions) {
  const engine = await ScenarioV2Engine.create(definition);
  for (const authored of definition.objects.filter((item) => item.transportable)) {
    assert.equal(
      engine.state.objects[authored.id].configuredAttachmentInterface,
      authored.attachmentInterface,
      `${definition.id}/${authored.id}: runtime must retain authored carrier compatibility`
    );
    assert.equal(engine.state.objects[authored.id].attachmentInterface, "", `${definition.id}/${authored.id}: compatible carrier must start detached`);
  }
}

for (const definition of definitions) {
  for (const execution of definition.validation.referenceExecutions) {
    const samples = [];
    const engine = await ScenarioV2Engine.create(definition, { onSample: (sample, index, state) => samples.push({ sample, index, state }) });
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: ${firstFailure(run)?.code || "execution failed"}`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: reference must satisfy outcome plus evidence`);
    assert.equal(run.state.lastReachedFrame, "home");
    assert.ok(
      samples.some((item) => item.sample.phase === "waypoint_logistics" && !item.sample.reachedFrame),
      `${definition.id}/${execution.id}: configured waypoint edges need intermediate visual samples`
    );
    for (const item of samples.filter((entry) => entry.sample.reachedFrame)) {
      assert.equal(item.sample.rootPose?.headingDeg, definition.frames[item.sample.reachedFrame].headingDeg, `${definition.id}/${item.sample.reachedFrame}: executed turn state must match the authored heading`);
    }
    for (const object of definition.objects.filter((item) => item.transportable)) {
      const loadedSamples = samples.filter((item) => item.state.objects[object.id]?.attachedTo);
      assert.ok(loadedSamples.length > 0, `${definition.id}/${object.id}: reference needs visible loaded motion`);
      assert.ok(loadedSamples.every((item) => item.state.objects[object.id].state.contentsSecured === true), `${definition.id}/${object.id}: contents must be secured during every loaded sample`);
      assert.ok(loadedSamples.some((item, index) => index > 0 && item.sample.rootPose?.headingDeg !== loadedSamples[index - 1].sample.rootPose?.headingDeg), `${definition.id}/${object.id}: loaded route must include an explicit configured turn state`);
    }
  }
  for (const execution of definition.validation.acceptedAlternates) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${definition.id}/${execution.id}: ${firstFailure(run)?.code || "execution failed"}`);
    assert.equal(run.grade.passed, true, `${definition.id}/${execution.id}: alternate must satisfy outcome plus evidence`);
    assert.equal(run.state.lastReachedFrame, "home");
  }
  for (const execution of definition.validation.negativeCases) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls || []);
    assert.equal(run.grade.passed, false, `${definition.id}/${execution.id}: negative case must fail grading`);
    if (execution.expectedFailureKind === "evidence") {
      assert.equal(run.ok, true, `${definition.id}/${execution.id}: evidence-only negative must execute successfully`);
      assert.ok(run.grade.goals.every((item) => item.passed), `${definition.id}/${execution.id}: evidence-only negative cannot fail a goal`);
      assert.ok(run.grade.prohibited.every((item) => !item.triggered), `${definition.id}/${execution.id}: evidence-only negative cannot trigger a prohibition`);
      assert.equal(run.grade.causal.length, 0);
      assert.ok(run.grade.evidence.some((item) => !item.passed));
    }
    if (execution.expectedFailureKind === "prohibited") {
      assert.equal(run.ok, true, `${definition.id}/${execution.id}: prohibited-only negative must execute successfully`);
      assert.ok(run.grade.goals.every((item) => item.passed), `${definition.id}/${execution.id}: prohibited-only negative cannot fail a goal`);
      assert.ok(run.grade.evidence.every((item) => item.passed), `${definition.id}/${execution.id}: prohibited-only negative cannot fail evidence`);
      assert.equal(run.grade.causal.length, 0);
      assert.ok(run.grade.prohibited.some((item) => item.triggered));
    }
    if (execution.expectedFailureKind === "causal") {
      assert.equal(run.ok, false, `${definition.id}/${execution.id}: incompatible apparatus must be rejected`);
      assert.equal(firstFailure(run)?.code, execution.expectedCode, `${definition.id}/${execution.id}: wrong API rejection`);
      assert.equal(run.state.eventLog.length, 0, `${definition.id}/${execution.id}: rejection must occur before contact or mutation`);
      assert.ok(run.grade.prohibited.every((item) => !item.triggered));
      assert.equal(run.grade.causal.length, 0);
    }
  }
}

console.log("G1 v2 family acceptance passed: ten structurally causal sources, references, alternates, and reason-specific negatives.");
