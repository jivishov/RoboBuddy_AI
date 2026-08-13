import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PythonRpcClient,
  ScenarioV2Engine,
  TrajectoryExecutor,
  buildContactSequence,
  canonicalRendererData,
  exportLegacyV1Archive,
  forwardKinematics,
  gradeScenario,
  homeJointState,
  ikRoundTrip,
  inverseKinematics,
  jointLimits,
  loadRobotModel,
  modelClaim,
  planJointPath,
  planOccupancyGridAStar,
  readLegacyV1Archive,
  requireStowedForDrive,
  sampleRenderedGeometry,
  validateProxyEnclosure,
  validateScenarioV2,
  withinJointLimits
} from "../lab/v2/index.js";
import { V2_BLOCK_DEFINITIONS, createV2Toolbox } from "../lab/v2/blockly-api.js";
import { stripValidationForClient } from "../lab/v2/scenario-schema.js";
import { ARM_RIG_CONFIG } from "../simulator/js/arm-rig-config.js";

const ROBOTS = ["arduino_arm", "so101_follower", "lekiwi_sim", "openarm_v2_bimanual", "unitree_g1_29dof"];
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); };

function targetState(model, chainId, magnitude = 8) {
  const state = homeJointState(model);
  jointLimits(model, chainId).forEach((item, index) => {
    state[item.id] = Math.max(item.min + 4, Math.min(item.max - 4, item.home + (index % 2 ? magnitude : -magnitude)));
  });
  return state;
}

function fixtureScenario(model) {
  const states = [0, 5, 10, 15, 20].map((amount) => targetState(model, "default", amount || 1));
  const roles = ["approach", "contact", "lift", "destination", "retreat"];
  const ids = ["pickup_approach", "pickup_contact", "pickup_lift", "destination", "retreat"];
  const frames = Object.fromEntries(ids.map((id, index) => [id, {
    positionMm: forwardKinematics(model, states[index], { chainId: "default" }).positionMm,
    role: roles[index],
    chainId: "default",
    tolerance: { positionMm: 3 },
    contactFixtureId: index === 1 ? "pickup_fixture" : undefined
  }]));
  return {
    schema: "robobuddy.lab-scenario.v2",
    id: "foundation-fixture-v2",
    title: "Foundation Fixture",
    brief: "Validate contact-gated transport.",
    robotId: "arduino_arm",
    rank: 1,
    supersedes: "arduino-arm-01-balance-placement",
    assistanceLevel: "Challenge",
    migration: { class: "A", legacyLearningObjective: "Plan and execute a bounded placement." },
    canonicalModel: { id: "arduino_arm", sourceRevision: model.source.revision },
    frames,
    fixtures: [{ id: "pickup_fixture", visible: true, label: "Pickup fixture" }],
    objects: [{ id: "sample", label: "Sample", initialFrame: "pickup_contact", compatibleEffectors: ["default"] }],
    grasps: [{ id: "sample-pinch", objectId: "sample", effector: "default", contactFrame: "pickup_contact" }],
    processModels: [],
    goalPredicates: [
      { id: "placed", op: "object_at", objectId: "sample", frameId: "destination" },
      { id: "retreated", op: "frame_visited", frameId: "retreat" }
    ],
    prohibitedStates: [{ id: "still-held", op: "attached_to", objectId: "sample", effector: "default" }],
    evidenceRequirements: [{ id: "placement_observation", label: "Placement observation", kind: "learner-recorded", minLength: 8, availableWhen: { op: "object_at", objectId: "sample", frameId: "destination" }, requiresEvent: { type: "DETACH_OBJECT", objectId: "sample" } }],
    provenance: [
      { label: "M", claim: "Arduino chain comes from the CAD-derived canonical rig.", sourceRef: "simulator/js/arm-rig-config.js" },
      { label: "R", claim: "Fixed-base manipulator role." },
      { label: "C", claim: "Task frames and tolerances are configured for this fixture." }
    ],
    modelClaim: modelClaim("arduino_arm"),
    api: { level: "challenge", namedFramesDiscoverable: true },
    navigation: {},
    validation: {
      referenceExecutions: [{ id: "reference", calls: [
        { method: "skills.transport", args: { objectId: "sample", approachFrame: "pickup_approach", contactFrame: "pickup_contact", liftFrame: "pickup_lift", destinationFrame: "destination", retreatFrame: "retreat", seed: 17 } },
        { method: "lab.record_evidence", args: { requirementId: "placement_observation", value: "Sample is visibly seated at the destination." } }
      ] }],
      acceptedAlternates: [{ id: "alternate-seed", calls: [
        { method: "skills.transport", args: { objectId: "sample", approachFrame: "pickup_approach", contactFrame: "pickup_contact", liftFrame: "pickup_lift", destinationFrame: "destination", retreatFrame: "retreat", seed: 991 } },
        { method: "lab.record_evidence", args: { requirementId: "placement_observation", value: "Destination placement verified." } }
      ] }],
      negativeCases: [{ id: "missing-evidence", expectedCode: "OUTCOME_OR_EVIDENCE_INCOMPLETE", calls: [] }]
    }
  };
}

await check("canonical model catalog and renderer bindings", async () => {
  for (const robotId of ROBOTS) {
    const model = await loadRobotModel(robotId);
    assert.equal(model.id, robotId);
    assert.ok(model.source.revision);
    assert.ok(model.fidelity);
    assert.ok(model.unsupportedPhysics.length);
  }
  await canonicalRendererData("arduino_arm", { kinematicChain: ARM_RIG_CONFIG.kinematicChain });
  const so101Mesh = (await import("../simulator/js/robot-mesh-data-so101.js")).ROBOT_RIG_MESH_DATA;
  const so101Canonical = await canonicalRendererData("so101_follower", so101Mesh);
  assert.deepEqual(so101Canonical.chain, JSON.parse(JSON.stringify((await loadRobotModel("so101_follower")).rendererChain)));
  const lekiwiMesh = (await import("../simulator/js/robot-mesh-data-lekiwi.js")).ROBOT_RIG_MESH_DATA;
  const lekiwiCanonical = await canonicalRendererData("lekiwi_sim", lekiwiMesh);
  assert.deepEqual(lekiwiCanonical.chain, JSON.parse(JSON.stringify((await loadRobotModel("lekiwi_sim")).rendererChain)));
  const mesh = (await import("../simulator/js/robot-mesh-data-openarm-v2.js")).ROBOT_RIG_MESH_DATA;
  const canonical = await canonicalRendererData("openarm_v2_bimanual", mesh);
  assert.equal(canonical.source.revision, (await loadRobotModel("openarm_v2_bimanual")).source.revision);
  assert.equal(canonical.chain.length, 21);
});

await check("FK parity, IK round-trip, unreachable targets, and joint limits", async () => {
  const cases = [
    ["arduino_arm", "default"], ["so101_follower", "default"], ["lekiwi_sim", "default"],
    ["openarm_v2_bimanual", "left"], ["openarm_v2_bimanual", "right"]
  ];
  for (const [robotId, chainId] of cases) {
    const model = await loadRobotModel(robotId);
    const state = targetState(model, chainId);
    const roundTrip = ikRoundTrip(model, state, { chainId, seed: 73, starts: 12, toleranceMm: 2.5 });
    assert.equal(roundTrip.inverse.ok, true, `${robotId}/${chainId} IK must round-trip`);
    assert.ok(roundTrip.positionErrorMm <= 2.5, `${robotId}/${chainId} round-trip residual`);
    assert.equal(withinJointLimits(model, roundTrip.inverse.jointState, chainId), true);
    const unreachable = inverseKinematics(model, [100000, 100000, 100000], { chainId, starts: 3, maxIterations: 25 });
    assert.equal(unreachable.ok, false);
    assert.equal(unreachable.code, "IK_UNREACHABLE");
  }
});

await check("collision proxy enclosure and bounded path planning", async () => {
  for (const robotId of ROBOTS) {
    const model = await loadRobotModel(robotId);
    const enclosure = validateProxyEnclosure(model, homeJointState(model));
    assert.equal(enclosure.ok, true, `${robotId} proxy enclosure`);
    assert.ok(enclosure.sampleCount > 0);
    assert.equal(enclosure.sampleProvenance, "authored-or-baked-renderer-mesh");
    const shiftedSamples = sampleRenderedGeometry(model, homeJointState(model)).slice(0, 1).map((sample) => ({
      ...sample,
      pointMm: sample.pointMm.map((value) => value + 100000)
    }));
    assert.equal(validateProxyEnclosure(model, homeJointState(model), { samples: shiftedSamples }).ok, false, `${robotId} must reject a renderer sample outside the proxy union`);
  }
  const model = await loadRobotModel("arduino_arm");
  const start = homeJointState(model);
  const goal = targetState(model, "default", 12);
  const planned = planJointPath(model, start, goal, [], { seed: 9 });
  assert.equal(planned.ok, true);
  assert.equal(planned.code, "BOUNDED_INTERPOLATION");
});

await check("LeKiwi A* and stow-before-drive", async () => {
  const model = await loadRobotModel("lekiwi_sim");
  const stowed = homeJointState(model);
  assert.equal(requireStowedForDrive(model, stowed).ok, true);
  assert.equal(requireStowedForDrive(model, { ...stowed, shoulder_lift: 30 }).code, "ARM_NOT_STOWED");
  const route = planOccupancyGridAStar({ width: 6, height: 6, resolutionMm: 50, originMm: [0, 0], blocked: ["2,1", "2,2", "2,3"] }, [0, 0], [250, 250]);
  assert.equal(route.ok, true);
  assert.ok(route.pathMm.length > 2);
});

await check("contact event gate, STOP retention, pause/resume, and reset", async () => {
  const events = [];
  const executor = new TrajectoryExecutor({ baseline: { jointState: { j: 0 } }, onEvent: (event) => events.push(event) });
  const trajectory = buildContactSequence([
    { phase: "pre_contact", samples: [{ jointState: { j: 1 } }] },
    { phase: "contact", samples: [{ jointState: { j: 2 }, events: [{ type: "CONTACT" }, { type: "ATTACH_OBJECT" }] }] },
    { phase: "lift", samples: [{ jointState: { j: 3 } }] },
    { phase: "transfer", samples: [{ jointState: { j: 4 } }] },
    { phase: "place", samples: [{ jointState: { j: 5 } }] },
    { phase: "retreat", samples: [{ jointState: { j: 6 } }] }
  ]);
  executor.load(trajectory);
  await executor.step();
  executor.pause();
  assert.equal(executor.snapshot().status, "paused");
  executor.resume();
  executor.stop("test");
  assert.deepEqual(executor.snapshot().lastSample.jointState, { j: 1 });
  assert.equal(events.length, 0, "stop before contact cannot attach");
  executor.reset();
  assert.deepEqual(executor.snapshot().lastSample, { jointState: { j: 0 } });
});

await check("ScenarioV2 validation, contact-gated outcomes, alternates, perturbation, fixed root", async () => {
  const model = await loadRobotModel("arduino_arm");
  const definition = fixtureScenario(model);
  assert.equal(validateScenarioV2(definition).ok, true);
  const clientDefinition = stripValidationForClient(definition);
  assert.equal(validateScenarioV2(clientDefinition).ok, false, "strict source validation still requires reference executions");
  assert.equal(validateScenarioV2(clientDefinition, { requireValidation: false }).ok, true, "generated client scenarios omit validation-only data");
  const clientEngine = await ScenarioV2Engine.create(clientDefinition);
  assert.equal(clientEngine.snapshot().scenarioId, definition.id);
  const prematureEvidence = await clientEngine.call("lab.record_evidence", { requirementId: "placement_observation", value: "Sample appears seated." });
  assert.equal(prematureEvidence.ok, false);
  assert.equal(prematureEvidence.code, "EVIDENCE_NOT_AVAILABLE");
  const directGate = await ScenarioV2Engine.create(definition);
  assert.throws(() => directGate.applyEvent({ type: "ATTACH_OBJECT", objectId: "sample", effector: "default" }), /before contact/);
  await assert.rejects(() => directGate.applyTrajectorySample({ rootPose: { positionMm: [10, 0, 0], headingDeg: 0 } }, 0), /Fixed robot root/);
  assert.equal(directGate.snapshot().fixedRootViolation, true);

  const wrongLocation = structuredClone(definition);
  wrongLocation.objects[0].initialFrame = "destination";
  const wrongLocationEngine = await ScenarioV2Engine.create(wrongLocation);
  const wrongLocationRun = await wrongLocationEngine.executeProgram(definition.validation.referenceExecutions[0].calls.slice(0, 1));
  assert.equal(wrongLocationRun.ok, false);
  assert.equal(wrongLocationRun.results[0].code, "OBJECT_NOT_AT_CONTACT");

  const wrongEffectorEngine = await ScenarioV2Engine.create(definition);
  const wrongEffectorCall = structuredClone(definition.validation.referenceExecutions[0].calls[0]);
  wrongEffectorCall.args.effector = "unconfigured_effector";
  const wrongEffectorRun = await wrongEffectorEngine.executeProgram([wrongEffectorCall]);
  assert.equal(wrongEffectorRun.ok, false);
  assert.equal(wrongEffectorRun.results[0].code, "EFFECTOR_INCOMPATIBLE");

  for (const execution of [definition.validation.referenceExecutions[0], definition.validation.acceptedAlternates[0]]) {
    const engine = await ScenarioV2Engine.create(definition);
    const run = await engine.executeProgram(execution.calls);
    assert.equal(run.ok, true, `${execution.id} API calls`);
    assert.equal(run.grade.passed, true, `${execution.id} grade`);
    const attach = run.state.eventLog.findIndex((event) => event.type === "ATTACH_OBJECT");
    const contact = run.state.eventLog.findIndex((event) => event.type === "CONTACT");
    assert.ok(contact >= 0 && attach > contact, `${execution.id} contact before attachment`);
  }
  const perturbed = await ScenarioV2Engine.create(definition);
  const partial = await perturbed.executeProgram(definition.validation.referenceExecutions[0].calls.slice(0, 1));
  assert.equal(partial.grade.passed, false);
  assert.equal(partial.grade.evidence[0].passed, false);

  const transportProcess = structuredClone(definition);
  transportProcess.processModels = [{
    id: "seat_check",
    label: "Configured seating check",
    discrete: true,
    contactGated: true,
    initialState: "not_ready",
    completeState: "complete",
    fixtureId: "pickup_fixture",
    prerequisites: [{ op: "object_at", objectId: "sample", frameId: "destination" }]
  }];
  transportProcess.goalPredicates.push({ id: "seat_complete", op: "process_state", processId: "seat_check", value: "complete" });
  const processEngine = await ScenarioV2Engine.create(transportProcess);
  const processCalls = structuredClone(definition.validation.referenceExecutions[0].calls);
  processCalls[0].args.processId = "seat_check";
  const processed = await processEngine.executeProgram(processCalls);
  assert.equal(processed.ok, true, "transport process should commit after placement satisfies its prerequisite");
  assert.equal(processed.state.processes.seat_check.state, "complete");
  const detachIndex = processed.state.eventLog.findIndex((event) => event.type === "DETACH_OBJECT");
  const processCommitIndex = processed.state.eventLog.findIndex((event) => event.type === "PROCESS_COMMIT");
  assert.ok(detachIndex >= 0 && processCommitIndex > detachIndex, "placement must be committed before its dependent process");

  const blockedProcess = structuredClone(transportProcess);
  blockedProcess.processModels[0].prerequisites = [{ op: "object_at", objectId: "sample", frameId: "pickup_contact" }];
  const blockedEngine = await ScenarioV2Engine.create(blockedProcess);
  const blocked = await blockedEngine.executeProgram(processCalls.slice(0, 1));
  assert.equal(blocked.ok, false, "transport process must reject an unsatisfied commit-time prerequisite");
  assert.equal(blocked.state.processes.seat_check.state, "not_ready");
  assert.equal(blocked.state.eventLog.length, 0, "failed process preflight cannot move or mutate the object");
  assert.equal(blocked.state.objects.sample.currentFrame, "pickup_contact");

  const fixtureEngine = await ScenarioV2Engine.create(transportProcess);
  const unknownObject = await fixtureEngine.call("skills.fixture_operation", { processId: "seat_check", objectId: "missing", fixtureId: "pickup_fixture", value: "complete" });
  assert.equal(unknownObject.code, "UNKNOWN_OBJECT");
  const unknownFixture = await fixtureEngine.call("skills.fixture_operation", { processId: "seat_check", objectId: "sample", fixtureId: "missing", value: "complete" });
  assert.equal(unknownFixture.code, "UNKNOWN_FIXTURE");
});

class FakeStorage {
  constructor(entries) { this.map = new Map(entries); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

await check("separate v2 storage and read-only legacy export", async () => {
  const storage = new FakeStorage([["robobuddy:lab-draft:v1:legacy:python", "print('legacy')"], ["robobuddy:lab:v2:progress:new", "{}"]]);
  const before = storage.getItem("robobuddy:lab-draft:v1:legacy:python");
  const archive = readLegacyV1Archive(storage);
  assert.equal(archive.readOnly, true);
  assert.equal(archive.entries.length, 1);
  assert.match(exportLegacyV1Archive(storage), /legacy/);
  assert.equal(storage.getItem("robobuddy:lab-draft:v1:legacy:python"), before);
});

class FakeWorker {
  constructor() { this.listeners = { message: [], error: [] }; this.outbound = []; this.pendingRun = null; }
  addEventListener(type, listener) { this.listeners[type].push(listener); }
  emit(data) { queueMicrotask(() => this.listeners.message.forEach((listener) => listener({ data }))); }
  postMessage(message) {
    this.outbound.push(message);
    if (message.type === "RUN") {
      this.pendingRun = message;
      if (message.python.includes("while True")) return;
      if (message.python.includes("raise RuntimeError")) { this.emit({ protocol: message.protocol, type: "RESULT", runId: message.runId, ok: false, code: "PYTHON_ERROR", error: "RuntimeError: boom" }); return; }
      this.emit({ protocol: message.protocol, type: "API_CALL", runId: message.runId, callId: `${message.runId}:call-1`, method: "lab.observe", args: { loopCount: 3, branch: true } });
    } else if (message.type === "API_RESULT" && this.pendingRun) {
      this.emit({ protocol: message.protocol, type: "RESULT", runId: this.pendingRun.runId, ok: true, code: "PYTHON_COMPLETE", stdout: "loop=3 branch=true", stderr: "" });
    }
  }
  terminate() { this.terminated = true; }
}

await check("bidirectional Python RPC loops/conditions, errors, timeout, pause/resume/cancel, and stale rejection", async () => {
  const workers = [];
  const client = new PythonRpcClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, apiHandler: async (method, args) => ({ ok: method === "lab.observe" && args.loopCount === 3 && args.branch }) });
  const completed = await client.run("async def main(robot, lab):\n    total = 0\n    for i in range(3): total += i\n    if total == 3: await lab.observe()", { timeoutMs: 500 });
  assert.equal(completed.ok, true);
  await assert.rejects(() => client.run("async def main(robot, lab):\n    raise RuntimeError('boom')", { timeoutMs: 500 }), /boom/);
  const timeout = client.run("async def main(robot, lab):\n    while True: pass", { timeoutMs: 120 });
  await assert.rejects(() => timeout, (error) => error.code === "PYTHON_TIMEOUT");
  const worker = workers.at(-1);
  worker.emit({ protocol: "robobuddy.pyodide-rpc.v2", type: "API_CALL", runId: "stale", callId: "stale-call", method: "lab.observe", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(worker.outbound.some((message) => message.type === "API_ERROR" && message.code === "STALE_CALL"));
  client.dispose();

  const cancelWorkers = [];
  const cancelClient = new PythonRpcClient({ workerFactory: () => { const next = new FakeWorker(); cancelWorkers.push(next); return next; }, cancelGraceMs: 5 });
  const cancelled = cancelClient.run("async def main(robot, lab):\n    while True: pass", { timeoutMs: 500 });
  assert.equal(cancelClient.cancel("emergency stop"), true);
  await assert.rejects(() => cancelled, (error) => error.code === "STOPPED");
  assert.equal(cancelWorkers[0].terminated, true, "non-responsive Pyodide worker must be terminated after cancel grace");
  cancelClient.dispose();
});

await check("layered Blockly surface and camera toggle regression", async () => {
  assert.ok(V2_BLOCK_DEFINITIONS.some((block) => block.level === "guided"));
  assert.ok(V2_BLOCK_DEFINITIONS.some((block) => block.level === "builder"));
  assert.ok(V2_BLOCK_DEFINITIONS.some((block) => block.level === "challenge"));
  assert.ok(V2_BLOCK_DEFINITIONS.some((block) => block.type === "v2_fixture_operation"));
  assert.equal(createV2Toolbox("guided").contents.length, 1);
  assert.equal(createV2Toolbox("builder").contents.length, 2);
  assert.equal(createV2Toolbox("challenge").contents.length, 3);
  const html = await readFile(new URL("../lab-workbench.html", import.meta.url), "utf8");
  const workbench = await readFile(new URL("../lab/js/workbench-v2.js", import.meta.url), "utf8");
  assert.match(html, /id="labCameraMovement"/);
  assert.match(html, /id="labCameraZoom"/);
  assert.match(workbench, /setCameraMovementEnabled/);
  assert.match(workbench, /setCameraZoomEnabled/);
});

await check("v2 browser entrypoint excludes legacy fabricated execution", async () => {
  const html = await readFile(new URL("../lab-workbench.html", import.meta.url), "utf8");
  const workbench = await readFile(new URL("../lab/js/workbench-v2.js", import.meta.url), "utf8");
  const catalog = await readFile(new URL("../lab/js/catalog.js", import.meta.url), "utf8");
  assert.match(html, /workbench-v2\.js/);
  assert.doesNotMatch(html, /lab\/js\/workbench\.js/);
  assert.match(workbench, /ScenarioV2Engine/);
  assert.match(workbench, /PythonRpcClient/);
  assert.match(workbench, /compileV2BlocklyProgram/);
  assert.doesNotMatch(workbench, /actions\.js|steps\.js|interactions\.js|equipment\.js|parsePythonProgram/);
  assert.match(catalog, /missions\/lab-assistant\/v2\/index\.json/);
});

console.log("RoboBuddy v2 foundation checks passed:");
checks.forEach((name) => console.log(`- ${name}`));
console.log(`- ${checks.length} focused foundation groups`);
