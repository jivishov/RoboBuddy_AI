import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScenarioV2Engine,
  loadRobotModel,
  modelClaim,
  requireStowedForDrive,
  validateScenarioV2
} from "../../../lab/v2/index.js";
import { validateRestPose } from "../../../lab/v2/physical-rest.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFINITIONS = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "lekiwi");
const LEGACY = resolve(ROOT, "missions", "lab-assistant", "v1");
const WORKBENCH = resolve(ROOT, "lab", "js", "workbench-v2.js");
const PUBLIC_ACTION_FIELDS = [
  "arm_shoulder_pan.pos", "arm_shoulder_lift.pos", "arm_elbow_flex.pos",
  "arm_wrist_flex.pos", "arm_wrist_roll.pos", "arm_gripper.pos",
  "x.vel", "y.vel", "theta.vel",
];
const ARM_FIELDS = PUBLIC_ACTION_FIELDS.slice(0, 5);
const ALLOWED_DIRECT_PROFILES = new Set(["beaker", "flask", "filter_flask", "bottle"]);
const EXPECTED = [
  ["lekiwi-01-beaker-courier", "lekiwi-01-beaker-courier", "A"],
  ["lekiwi-02-glassware-route", "lekiwi-02-sample-fetch", "B"],
  ["lekiwi-03-sample-delivery", "lekiwi-03-mobile-weighing", "B"],
  ["lekiwi-04-filter-station-run", "lekiwi-04-cuvette-rack", "B"],
  ["lekiwi-05-reagent-shuttle", "lekiwi-05-waste-return", "B"],
  ["lekiwi-06-cooling-rack-route", "lekiwi-06-dilution-route", "C"],
  ["lekiwi-07-chromatography-route", "lekiwi-07-filtration-supply", "C"],
  ["lekiwi-08-spectrometer-route", "lekiwi-08-cooled-precipitate", "C"],
  ["lekiwi-09-titration-logistics", "lekiwi-09-spectro-route", "C"],
  ["lekiwi-10-hard-water-logistics", "lekiwi-10-hard-water-logistics", "C"]
];

const files = (await readdir(DEFINITIONS)).filter((name) => name.endsWith(".json")).sort();
assert.equal(files.length, 10, "LeKiwi owns exactly ten ScenarioV2 definitions");
const definitions = await Promise.all(files.map(async (file) => JSON.parse(await readFile(resolve(DEFINITIONS, file), "utf8"))));
const model = await loadRobotModel("lekiwi_sim");
const canonicalClaim = modelClaim("lekiwi_sim");
const workbenchSource = await readFile(WORKBENCH, "utf8");

assert.match(workbenchSource, /from lerobot\.robots\.lekiwi import LeKiwiClient, LeKiwiClientConfig/);
assert.ok(workbenchSource.includes('LeKiwiClient(LeKiwiClientConfig(remote_ip=transport[\\"remote_ip\\"], cameras={}))'));
assert.ok(workbenchSource.includes('robot.send_action(step[\\"action\\"])'));

assert.deepEqual(
  definitions.map((definition) => [definition.id, definition.supersedes, definition.migration.class]),
  EXPECTED,
  "new ids, immutable v1 mappings, and A/B/C classifications remain rank aligned"
);
assert.deepEqual(definitions.map((definition) => definition.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

let references = 0;
let alternates = 0;
let negatives = 0;
for (const definition of definitions) {
  const validation = validateScenarioV2(definition);
  assert.equal(validation.ok, true, validation.errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
  const legacy = JSON.parse(await readFile(resolve(LEGACY, `${definition.supersedes}.json`), "utf8"));
  assert.equal(definition.schemaVersion, 2);
  assert.equal(definition.canonicalModelId, "lekiwi_sim");
  assert.equal(definition.legacyClassification, definition.migration.class);
  assert.equal(definition.migration.legacyLearningObjective, legacy.objectives.join(" "));
  assert.deepEqual(definition.migration.legacySuccessCriteria, legacy.successCriteria);
  assert.equal(definition.canonicalModel.sourceRevision, model.source.revision);
  assert.deepEqual(definition.modelClaim, canonicalClaim);
  assert.deepEqual(new Set(definition.provenance.map((entry) => entry.label)), new Set(["M", "F", "R", "C"]));
  assert.ok(definition.fixtures.every((fixture) => fixture.visible === true));
  const transferBench = definition.fixtures.find((fixture) => fixture.id === "pickup_cradle");
  const receivingZone = definition.fixtures.find((fixture) => fixture.id === "destination_fixture");
  assert.equal(transferBench.type, "configured_real_transfer_bench");
  assert.equal(transferBench.collisionProxies.length, 2, "real bench has one worktop and one broad structural back panel");
  assert.ok(transferBench.collisionProxies.every((proxy) => proxy.type === "box"));
  assert.ok(transferBench.collisionProxies.every((proxy) => proxy.provenance?.startsWith("C:")));
  assert.equal(transferBench.collisionProxies[0].planningRole, "contact_surface");
  assert.ok(transferBench.collisionProxies[1].halfExtentsMm[1] >= 95 && transferBench.collisionProxies[1].halfExtentsMm[2] >= 120, "bench support is a broad structural panel, not a thin stick");
  assert.equal(receivingZone.presentationOnly, true);
  assert.deepEqual(receivingZone.collisionProxies, []);
  assert.match(receivingZone.claimBoundary, /carries no load/);
  const object = definition.objects.find((item) => item.transportable !== false);
  assert.ok(object, `${definition.id}: one directly handled apparatus object is required`);
  assert.equal(object.visible, true);
  assert.equal(object.visual.directHandling, true);
  assert.equal(object.visual.containerFree, true);
  assert.equal(object.physicalRest.directHandling, true);
  assert.equal(object.physicalRest.containerFree, true);
  assert.equal(object.attachmentInterface, "direct_apparatus_grip");
  assert.ok(ALLOWED_DIRECT_PROFILES.has(object.configuredApparatusProfile), `${definition.id}: payload must be direct upright lab apparatus`);
  assert.doesNotMatch(object.label, /(?:tray|carrier|cassette|rack|bin|box|watch glass|cuvette|plate)/i);
  assert.doesNotMatch(object.visual.type, /(?:tray|carrier|cassette|rack|bin|box)/i);
  assert.equal(object.physicalRest.schema, "robobuddy.physical-rest.v1");
  assert.equal(object.physicalRest.tolerance.maxTiltDeg, 2);
  assert.equal(object.physicalRest.tolerance.maxGapMm, 2.5);
  assert.equal(object.physicalRest.tolerance.maxPenetrationMm, 0.5);
  for (const frameId of [object.initialFrame, "delivery"]) {
    const pose = object.physicalRest.poses[frameId];
    const rest = validateRestPose(definition, object, { position: pose.positionMm, rotation: pose.rotationMatrix }, frameId);
    assert.equal(rest.ok, true, `${definition.id}/${frameId}: ${rest.reasons.join("; ")}`);
    assert.ok(rest.gapMm >= -0.5 && rest.gapMm <= 2.5, `${definition.id}/${frameId}: nonpenetrating support contact`);
    assert.ok(rest.tiltDeg <= 2, `${definition.id}/${frameId}: upright apparatus rest`);
    assert.ok(rest.minimumMarginMm >= 2, `${definition.id}/${frameId}: stable supported footprint`);
  }
  const calibration = object.physicalRest.referenceCalibration;
  assert.equal(calibration.physicalHardwareValidated, false);
  assert.deepEqual(calibration.contactBodies, ["wrist_roll_08c_v1__", "moving_jaw_08d_v1__"]);
  assert.ok(calibration.finalGapMm >= -0.5 && calibration.finalGapMm <= 2.5);
  assert.ok(calibration.finalTiltDeg <= 2);
  assert.match(calibration.releasePoseSource, /actual opened-gripper FK pose; no release teleport/);
  assert.equal(definition.portablePython.claim, "API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending.");
  assert.deepEqual(definition.portablePython.officialLeRobotContract.imports, [
    "lerobot.robots.lekiwi.LeKiwiClient",
    "lerobot.robots.lekiwi.LeKiwiClientConfig",
  ]);
  assert.equal(definition.portablePython.officialLeRobotContract.publicCommand, "robot.send_action(action)");
  assert.deepEqual(definition.portablePython.officialLeRobotContract.actionFields, PUBLIC_ACTION_FIELDS);
  assert.equal(definition.portablePython.learnerGradingCalls, false);
  assert.equal(definition.portablePython.openGripperApproachPlanning, undefined, "stale alternate-base planning claims are forbidden");
  for (const step of definition.portablePython.referenceActions) {
    assert.deepEqual(Object.keys(step.action).sort(), [...PUBLIC_ACTION_FIELDS].sort(), `${definition.id}/${step.label}: official nine-field action`);
    const baseMoving = ["x.vel", "y.vel", "theta.vel"].some((field) => Math.abs(step.action[field]) > 1e-9);
    if (baseMoving) {
      assert.ok(ARM_FIELDS.every((field) => Math.abs(step.action[field]) <= 1e-9), `${definition.id}/${step.label}: base drives only with arm stowed`);
      assert.equal(step.action["arm_gripper.pos"], 20, `${definition.id}/${step.label}: base drives with the gripper open`);
    } else {
      assert.ok(["x.vel", "y.vel", "theta.vel"].every((field) => step.action[field] === 0), `${definition.id}/${step.label}: arm phase cannot drift the base`);
    }
  }
  const placementStep = definition.portablePython.referenceActions.find((step) => step.label === "placement contact");
  const releaseStep = definition.portablePython.referenceActions.find((step) => step.label === "release at live tool pose");
  assert.ok(placementStep && releaseStep, `${definition.id}: placement and release actions are explicit`);
  assert.deepEqual(ARM_FIELDS.map((field) => releaseStep.action[field]), ARM_FIELDS.map((field) => placementStep.action[field]), `${definition.id}: release opens at the live placement pose`);
  assert.ok(placementStep.action["arm_gripper.pos"] > releaseStep.action["arm_gripper.pos"], `${definition.id}: release is caused by an open command`);
  assert.ok(definition.processModels.every((process) => process.discrete && process.contactGated));
  assert.ok(definition.processModels.every((process) => process.prerequisites.length > 0));
  assert.ok(definition.evidenceRequirements.every((requirement) => requirement.availableWhen && requirement.requiresEvent));
  assert.equal(definition.navigation.planner, "planar occupancy-grid A*");
  assert.equal(definition.navigation.routeOptions.length, 2);
  assert.match(definition.navigation.clearanceModel, /Point-cell occupancy only/);
  assert.ok(definition.navigation.prohibitedCapabilities.includes("footprint-clearance guarantee"));
  assert.ok(definition.objects.every((object) => object.initialState.contentsModel === "not simulated"));
  assert.ok(definition.objects.every((object) => object.initialState.payloadModel === "not simulated"));
  assert.ok(definition.processModels.every((process) => /no chemical, thermal, force, payload, fluid, or measurement effect/.test(process.modeledEffect)));
  if (definition.migration.class === "B") assert.ok(definition.migration.fixtureAssistance);
  if (definition.migration.class === "C") assert.ok(definition.migration.redesignRationale);

  const routeEngine = await ScenarioV2Engine.create(definition);
  const primary = routeEngine.planBasePath(definition.frames.service_base.basePositionMm);
  const alternate = routeEngine.planBasePath(definition.frames.alternate_service_base.basePositionMm);
  assert.equal(primary.ok, true);
  assert.equal(alternate.ok, true);
  assert.equal(primary.code, "BASE_PATH_READY");
  assert.equal(alternate.code, "BASE_PATH_READY");
  assert.notDeepEqual(primary.path.cells, alternate.path.cells, "alternate route cannot duplicate the primary cell path");
  assert.notDeepEqual(primary.path.cells.at(-1), alternate.path.cells.at(-1), "alternate route reaches a distinct configured base stop");
  const blocked = new Set(definition.navigation.occupancyGrid.blocked);
  for (const route of [primary.path, alternate.path]) {
    assert.equal(route.code, "A_STAR");
    assert.ok(route.cells.length > 2);
    assert.ok(route.cells.every(([x, y]) => !blocked.has(`${x},${y}`)), "A* route avoids every configured occupied cell");
  }

  const unstowed = await ScenarioV2Engine.create(definition);
  unstowed.state.jointState.shoulder_lift = 30;
  const rejectedDrive = await unstowed.call("robot.navigate", { frameId: "service_base" });
  assert.equal(rejectedDrive.ok, false);
  assert.equal(rejectedDrive.code, "ARM_NOT_STOWED");

  const earlyEvidence = await (await ScenarioV2Engine.create(definition)).call("lab.record_evidence", {
    requirementId: "route_and_placement_observation",
    value: "Configured route used; object delivered and visibly seated."
  });
  assert.equal(earlyEvidence.ok, false);
  assert.equal(earlyEvidence.code, "UNKNOWN_EVIDENCE", "portable tasks expose no learner-callable grading/evidence API");

  const prematureProcess = await (await ScenarioV2Engine.create(definition)).call("skills.fixture_operation", {
    processId: "placement_latch",
    objectId: definition.objects[0].id,
    fixtureId: "destination_fixture",
    value: "seated"
  });
  assert.equal(prematureProcess.ok, false);
  assert.equal(prematureProcess.code, "PROCESS_PREREQUISITE");

  const causalProbe = await ScenarioV2Engine.create(definition);
  const objectId = object.id;
  const beforeDrive = causalProbe.snapshot().objects[objectId];
  const drove = await causalProbe.call("robot.navigate", { frameId: "service_base" });
  assert.equal(drove.ok, true);
  assert.deepEqual(causalProbe.snapshot().objects[objectId], beforeDrive, "base motion does not mutate the task object");
  assert.equal(causalProbe.snapshot().eventLog.length, 0, "base phase cannot fabricate contact");
  if (definition.processModels[0].prerequisites[0].op === "all") {
    const secondStop = await causalProbe.call("robot.navigate", { frameId: "alternate_service_base" });
    assert.equal(secondStop.ok, true);
  }
  const portable = await ScenarioV2Engine.create(definition, { autoStartPlant: false });
  assert.equal((await portable.call("compat.connect", { instanceId: "lekiwi-test", config: { kind: "lekiwi", remote_ip: "127.0.0.1", cameras: {} } })).ok, true);
  for (const step of definition.portablePython.referenceActions) {
    const sent = await portable.call("compat.send_action", { instanceId: "lekiwi-test", action: step.action, options: {} });
    assert.equal(sent.ok, true, `${definition.id}/${step.label}`);
    for (let tick = 0; tick < Math.ceil(step.hold_seconds / portable.plant.tickSeconds); tick += 1) portable.plant.tick();
    assert.equal(portable.plant.fault, null, `${definition.id}/${step.label} must remain collision clear`);
  }
  await portable.call("compat.disconnect", { instanceId: "lekiwi-test" });
  const completed = portable.snapshot();
  assert.equal(completed.grade.passed, true, `${definition.id}: authoritative portable grade`);
  assert.ok(completed.rootPose.positionMm.every((value) => Math.abs(value) < 0.5), `${definition.id}: base returns home within 0.5 mm`);
  assert.equal(requireStowedForDrive(model, completed.jointState).ok, true);
  const types = completed.eventLog.map((event) => event.type);
  for (const requiredType of ["CONTACT", "ATTACH_OBJECT", "PLACE_CONTACT", "DETACH_OBJECT"]) assert.ok(types.includes(requiredType), `${definition.id}: ${requiredType} event required`);
  assert.ok(types.indexOf("CONTACT") < types.indexOf("ATTACH_OBJECT"));
  assert.ok(types.indexOf("ATTACH_OBJECT") < types.indexOf("PLACE_CONTACT"));
  assert.ok(types.indexOf("PLACE_CONTACT") < types.indexOf("DETACH_OBJECT"));
  assert.equal(types.includes("GRASP_REJECTED"), false);
  const attached = completed.eventLog.find((event) => event.type === "ATTACH_OBJECT");
  const detached = completed.eventLog.find((event) => event.type === "DETACH_OBJECT");
  assert.deepEqual(attached.contactBodies, calibration.contactBodies, `${definition.id}: both independently inspected LeKiwi finger bodies cause attachment`);
  assert.equal(detached.stableRest, true);
  assert.equal(detached.frameId, "delivery");
  const releasedObject = completed.objects[objectId];
  assert.ok(Math.hypot(...releasedObject.worldPositionMm.map((value, axis) => value - detached.worldPositionMm[axis])) < 1e-6, `${definition.id}: release cannot teleport the apparatus`);
  assert.ok(types.includes("PROCESS_CONTACT"), "fixture state requires modeled physical contact");
  assert.ok(types.indexOf("PROCESS_CONTACT") < types.indexOf("PROCESS_COMMIT"));
  references += 1;

  for (const execution of definition.validation.acceptedAlternates) {
    assert.equal(execution.calls, undefined, `${definition.id}/${execution.id}: symbolic learner calls removed`);
    assert.equal(execution.portableProgram.learnerGradingCalls, false);
    alternates += 1;
  }
  for (const execution of definition.validation.negativeCases) {
    assert.equal(execution.calls, undefined, `${definition.id}/${execution.id}: symbolic learner calls removed`);
    assert.equal(execution.portableNegative, true);
    negatives += 1;
  }
}

assert.equal(references, 10);
assert.equal(alternates, 10);
assert.equal(negatives, 50);
console.log("LeKiwi ScenarioV2 family acceptance passed:");
console.log("- 10 schema-valid, rank-aligned successors preserve v1 objectives and success criteria");
console.log("- 10 official LeKiwiClient.send_action traces completed collision-clear, causally handled direct apparatus, and returned home stowed");
console.log("- initial/final real-surface rest, two independently sampled finger contacts, live-pose release, and no-teleport invariants passed");
console.log("- 10 alternate route definitions and 50 portable negative programs retain their fail-closed metadata");
console.log("- official starter imports, complete nine-field public actions, watchdog-safe base timing, and bounded claims verified");
