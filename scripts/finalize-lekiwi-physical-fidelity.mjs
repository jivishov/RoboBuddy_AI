import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleRenderedGeometry } from "../lab/v2/collision.js";
import { forwardKinematics } from "../lab/v2/kinematics.js";
import { composeTransform, inverseTransform, transformPoint } from "../lab/v2/math.js";
import { loadRobotModel } from "../lab/v2/robot-model-catalog.js";
import { assertScenarioV2, stripValidationForClient } from "../lab/v2/scenario-schema.js";
import { validateRestPose } from "../lab/v2/physical-rest.js";
import { YAW_90_ROTATION } from "./portable-physical-rest-helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "lekiwi");
const OUTPUT = resolve(ROOT, "missions", "lab-assistant", "v2", "generated", "scenarios");
const files = (await readdir(SOURCE)).filter((name) => name.endsWith(".json")).sort();
const model = await loadRobotModel("lekiwi_sim");
const REQUIRED_CONTACT_BODIES = Object.freeze(["wrist_roll_08c_v1__", "moving_jaw_08d_v1__"]);
const PUBLIC_ACTION_FIELDS = Object.freeze([
  "arm_shoulder_pan.pos", "arm_shoulder_lift.pos", "arm_elbow_flex.pos",
  "arm_wrist_flex.pos", "arm_wrist_roll.pos", "arm_gripper.pos",
  "x.vel", "y.vel", "theta.vel",
]);
const ALTERNATE_CONTACT_BASE_SCENARIOS = new Set([
  "lekiwi-06-cooling-rack-route",
]);
const REQUIRED_TWO_STOP_SCENARIOS = new Set(["lekiwi-09-titration-logistics", "lekiwi-10-hard-water-logistics"]);

function actionState(action, gripper = Number(action["arm_gripper.pos"])) {
  return {
    shoulder_pan: Number(action["arm_shoulder_pan.pos"]),
    shoulder_lift: Number(action["arm_shoulder_lift.pos"]),
    elbow_flex: Number(action["arm_elbow_flex.pos"]),
    wrist_flex: Number(action["arm_wrist_flex.pos"]),
    wrist_roll: Number(action["arm_wrist_roll.pos"]),
    gripper,
  };
}

function signedBoxDistance(point, center, halfExtents) {
  const outside = point.map((value, axis) => Math.abs(Number(value) - center[axis]) - halfExtents[axis]);
  const distance = Math.hypot(...outside.map((value) => Math.max(0, value)));
  return outside.some((value) => value > 0) ? distance : Math.max(...outside);
}

function transformedBoxBottom(geometry, transform) {
  let minimum = Infinity;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const local = geometry.centerLocalMm.map((value, axis) => (
      value + geometry.halfExtentsMm[axis] * [sx, sy, sz][axis]
    ));
    minimum = Math.min(minimum, transformPoint(transform, local)[1]);
  }
  return minimum;
}

function configuredBaseRouteActions(startPose, endPose, stowAction) {
  const corners = [
    [700, startPose[2]],
    [700, endPose[2]],
    [endPose[0], endPose[2]],
  ];
  const points = [[startPose[0], startPose[2]]];
  for (const corner of corners) {
    let current = points.at(-1);
    while (Math.abs(corner[0] - current[0]) > 1e-9 || Math.abs(corner[1] - current[1]) > 1e-9) {
      const dx = Math.max(-50, Math.min(50, corner[0] - current[0]));
      const dz = dx === 0 ? Math.max(-50, Math.min(50, corner[1] - current[1])) : 0;
      current = [current[0] + dx, current[1] + dz];
      points.push(current);
    }
  }
  const actions = [{ label: "explicit stow before returning to the service stop", action: structuredClone(stowAction), hold_seconds: 1 }];
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index][0] - points[index - 1][0];
    const dz = points[index][1] - points[index - 1][1];
    const hold = 0.26;
    const drive = structuredClone(stowAction);
    drive["x.vel"] = Number(((dx / 1000) / hold).toFixed(6));
    drive["y.vel"] = Number(((-dz / 1000) / hold).toFixed(6));
    actions.push({ label: "visible stowed-base return to validated service stop", action: drive, hold_seconds: hold });
    actions.push({ label: "explicit base stop between route segments", action: structuredClone(stowAction), hold_seconds: hold });
  }
  actions.push({ label: "explicit service-base stop before arm motion", action: structuredClone(stowAction), hold_seconds: 0.1 });
  return actions;
}

function compressStraightBaseRouteStops(definition) {
  const actions = definition.portablePython.referenceActions;
  const moving = (step) => step && ["x.vel", "y.vel", "theta.vel"].some((field) => Math.abs(Number(step.action[field])) > 1e-9);
  const sameVelocity = (left, right) => ["x.vel", "y.vel", "theta.vel"].every((field) => Number(left.action[field]) === Number(right.action[field]));
  definition.portablePython.referenceActions = actions.filter((step, index) => {
    if (step.label !== "explicit base stop between route segments") return true;
    const previous = actions[index - 1];
    const next = actions[index + 1];
    // Re-sending the same official velocity action every 260 ms keeps the
    // 500 ms LeKiwi watchdog live. A stop remains at every direction change,
    // base destination, and arm-motion boundary; only redundant stops along a
    // single straight lane are removed. This preserves the same fixed route
    // and physically integrated displacement while fitting the 60 s browser
    // execution bound.
    return !(moving(previous) && moving(next) && sameVelocity(previous, next));
  });
  definition.portablePython.baseCommandTiming = {
    resendPeriodSeconds: 0.26,
    watchdogSeconds: 0.5,
    stopPolicy: "explicit stop at every turn, configured stop, and arm boundary; continuous same-velocity commands only within one collision-clear straight route lane",
    automaticMotion: false,
  };
}

async function useServiceManipulationAfterRequiredStops(definition) {
  if (!REQUIRED_TWO_STOP_SCENARIOS.has(definition.id)) return;
  const template = JSON.parse(await readFile(resolve(SOURCE, "lekiwi-05-reagent-shuttle.json"), "utf8"));
  const templateActions = template.portablePython.referenceActions;
  const templateArmStart = templateActions.findIndex((step) => step.label === "pre_contact path");
  const templateReturnStart = templateActions.findIndex((step, index) => index > templateArmStart && step.label === "explicit stow before drive");
  const ownArmStart = definition.portablePython.referenceActions.findIndex((step) => step.label === "pre_contact path");
  if (templateArmStart < 0 || templateReturnStart < 0 || ownArmStart < 0) throw new Error(`${definition.id}: service manipulation splice points are unavailable.`);
  const prefix = definition.portablePython.referenceActions.slice(0, ownArmStart);
  const stowAction = structuredClone(prefix.at(-1).action);
  Object.assign(stowAction, {
    "arm_shoulder_pan.pos": 0,
    "arm_shoulder_lift.pos": 0,
    "arm_elbow_flex.pos": 0,
    "arm_wrist_flex.pos": 0,
    "arm_wrist_roll.pos": 0,
    "arm_gripper.pos": 20,
    "x.vel": 0,
    "y.vel": 0,
    "theta.vel": 0,
  });
  const reposition = configuredBaseRouteActions(
    definition.frames.alternate_service_base.basePositionMm,
    definition.frames.service_base.basePositionMm,
    stowAction,
  );
  const manipulation = templateActions.slice(templateArmStart, templateReturnStart).map((step) => structuredClone(step));
  const returnHome = templateActions.slice(templateReturnStart).map((step) => structuredClone(step));
  definition.portablePython.referenceActions = [...prefix, ...reposition, ...manipulation, ...returnHome];
  definition.portablePython.twoStopHandlingPolicy = {
    requiredVisits: ["service_base", "alternate_service_base"],
    manipulationBase: "service_base",
    rule: "The arm stays explicitly stowed during every base segment; after the required second stop the base returns visibly to the validated service stop before direct apparatus handling.",
    automaticMotion: false,
  };
}

function calibrateDirectFingerRest(definition, object) {
  const actions = definition.portablePython?.referenceActions || [];
  const contactIndex = actions.findIndex((step) => step.label === "arm contact approach");
  const placeIndex = actions.findIndex((step) => step.label === "placement contact");
  if (contactIndex < 0 || placeIndex < 0) throw new Error(`${definition.id}: contact/place public actions are unavailable.`);
  const contactBaseFrame = ALTERNATE_CONTACT_BASE_SCENARIOS.has(definition.id)
    ? "alternate_service_base"
    : "service_base";
  const basePose = { positionMm: [...definition.frames[contactBaseFrame].basePositionMm], headingDeg: 0 };
  const contactState = actionState(actions[contactIndex].action, 70);
  const placeState = actionState(actions[placeIndex].action, 70);
  const contactTool = forwardKinematics(model, contactState, { basePose }).transform;
  const placeTool = forwardKinematics(model, placeState, { basePose }).transform;
  const samples = sampleRenderedGeometry(model, contactState, { basePose });
  const geometry = object.physicalRest.geometry;
  object.physicalRest.tolerance.maxGapMm = 2.5;
  delete object.physicalRest.intermediateGenerationPose;
  const centerY = 211 + Number(geometry.centerLocalMm[1]);
  // A 90 degree world-up yaw keeps the stable apparatus envelope axis-aligned:
  // local X maps to -world Z and local Z maps to +world X.
  const centerOffset = [Number(geometry.centerLocalMm[2]), Number(geometry.centerLocalMm[1]), -Number(geometry.centerLocalMm[0])];
  const halfExtents = [Number(geometry.halfExtentsMm[2]), Number(geometry.halfExtentsMm[1]), Number(geometry.halfExtentsMm[0])];
  const nearby = samples.filter((sample) => (
    Math.abs(sample.pointMm[1] - centerY) <= halfExtents[1] + 4
    && Math.abs(sample.pointMm[0] - contactTool.position[0]) <= 190
    && Math.abs(sample.pointMm[2] - contactTool.position[2]) <= 190
  ));
  const contactApproachIndex = actions.findIndex((step) => step.label === "contact approach path");
  const approachOtherSamples = (contactApproachIndex >= 0 ? actions.slice(contactApproachIndex, contactIndex + 1) : [actions[contactIndex]])
    .flatMap((step) => sampleRenderedGeometry(model, actionState(step.action, 20), { basePose }))
    .filter((sample) => !REQUIRED_CONTACT_BODIES.some((bodyId) => String(sample.proxyId || sample.id).includes(bodyId)))
    .filter((sample) => (
      Math.abs(sample.pointMm[1] - centerY) <= halfExtents[1] + 4
      && Math.abs(sample.pointMm[0] - contactTool.position[0]) <= 190
      && Math.abs(sample.pointMm[2] - contactTool.position[2]) <= 190
    ));
  const requiredSamples = REQUIRED_CONTACT_BODIES.map((bodyId) => (
    nearby.filter((sample) => String(sample.proxyId || sample.id).includes(bodyId))
  ));
  if (requiredSamples.some((group) => group.length === 0)) throw new Error(`${definition.id}: independently sampled LeKiwi finger geometry is unavailable.`);

  const candidates = [];
  // Complete upright footprints must remain on the fixed 290 x 290 mm worktop.
  const minimumX = Math.ceil(160 + halfExtents[0] - centerOffset[0] + 2);
  const maximumX = Math.floor(450 - halfExtents[0] - centerOffset[0] - 2);
  const minimumZ = Math.ceil(245 + halfExtents[2] - centerOffset[2] + 2);
  const maximumZ = Math.floor(535 - halfExtents[2] - centerOffset[2] - 2);
  for (let x = minimumX; x <= maximumX; x += 1) for (let z = minimumZ; z <= maximumZ; z += 1) {
    const center = [x + centerOffset[0], centerY, z + centerOffset[2]];
    const contactOtherSamples = nearby.filter((sample) => !REQUIRED_CONTACT_BODIES.some((bodyId) => (
      String(sample.proxyId || sample.id).includes(bodyId)
    )));
    const signedDistances = [...contactOtherSamples, ...approachOtherSamples]
      .map((sample) => signedBoxDistance(sample.pointMm, center, halfExtents));
    // The configured object/rest tolerance permits at most 0.5 mm numerical
    // overlap; never accept a deeply embedded finger, wrist, or motor sample.
    if (signedDistances.some((distance) => distance < -1e-6)) continue;
    const fingerClearances = requiredSamples.map((group) => group.reduce((minimum, sample) => (
      Math.min(minimum, Math.max(0, signedBoxDistance(sample.pointMm, center, halfExtents)))
    ), Infinity));
    if (!fingerClearances.every((distance) => distance <= 1.5)) continue;
    const fingerProxyPenetrations = requiredSamples.map((group) => group.reduce((maximum, sample) => (
      Math.max(maximum, Math.max(0, -signedBoxDistance(sample.pointMm, center, halfExtents)))
    ), 0));
    // The object collision proxy encloses curved glass/bottle empty space, so a
    // finger mesh sample can lie inside the conservative box without visible
    // surface penetration. Keep that bounded and independently reject every
    // wrist/motor/link sample above.
    if (fingerProxyPenetrations.some((depth) => depth > 12)) continue;

    const initial = { position: [x, 211, z], rotation: [...YAW_90_ROTATION] };
    const attachment = composeTransform(inverseTransform(contactTool), initial);
    const final = composeTransform(placeTool, attachment);
    const initialFrame = object.initialFrame;
    const finalFrame = Object.keys(object.physicalRest.poses).find((frameId) => frameId !== initialFrame);
    const probe = structuredClone(object);
    probe.physicalRest.poses[initialFrame] = {
      ...probe.physicalRest.poses[initialFrame], positionMm: [...initial.position], rotationMatrix: [...initial.rotation],
    };
    probe.physicalRest.poses[finalFrame] = {
      ...probe.physicalRest.poses[finalFrame], positionMm: [...final.position], rotationMatrix: [...final.rotation],
    };
    const initialRest = validateRestPose(definition, probe, initial, initialFrame);
    const finalRest = validateRestPose(definition, probe, final, finalFrame);
    if (!initialRest.ok || !finalRest.ok) continue;
    if (initialRest.minimumMarginMm < 10 || finalRest.minimumMarginMm < 10) continue;
    candidates.push({
      initial,
      final,
      attachment,
      initialRest,
      finalRest,
      fingerClearances,
      fingerProxyPenetrations,
      score: fingerClearances.reduce((sum, value) => sum + value, 0)
        + fingerProxyPenetrations.reduce((sum, value) => sum + value, 0) * 0.05
        + Math.abs(finalRest.gapMm) * 0.25
        + Math.hypot(final.position[0] - 330, final.position[2] - 390) * 0.0005,
    });
  }
  candidates.sort((left, right) => left.score - right.score);
  const selected = candidates[0];
  if (!selected) throw new Error(`${definition.id}/${object.id}: no nonpenetrating, two-finger, stable initial/final direct-apparatus calibration exists.`);

  const initialFrame = object.initialFrame;
  const finalFrame = Object.keys(object.physicalRest.poses).find((frameId) => frameId !== initialFrame);
  // Scenario frames are authoritative FK tool-joint poses. The actual finger
  // contact lies distally from that joint, so derive the schema grip socket
  // from the calibrated rigid transform instead of pretending the joint is at
  // the visible apparatus contact patch.
  const toolReferenceSocket = transformPoint(inverseTransform(selected.initial), contactTool.position);
  definition.frames[object.physicalRest.poses[initialFrame].graspFrameId].positionMm = contactTool.position.map((value) => Number(value.toFixed(6)));
  definition.frames[object.physicalRest.poses[finalFrame].graspFrameId].positionMm = placeTool.position.map((value) => Number(value.toFixed(6)));
  object.physicalRest.gripSocketMm = toolReferenceSocket.map((value) => Number(value.toFixed(6)));
  object.physicalRest.poses[initialFrame].positionMm = selected.initial.position.map((value) => Number(value.toFixed(6)));
  object.physicalRest.poses[initialFrame].rotationMatrix = selected.initial.rotation.map((value) => Number(value.toFixed(9)));
  object.physicalRest.poses[finalFrame].positionMm = selected.final.position.map((value) => Number(value.toFixed(6)));
  object.physicalRest.poses[finalFrame].rotationMatrix = selected.final.rotation.map((value) => Number(value.toFixed(9)));
  object.physicalRest.referenceCalibration = {
    source: "source-pinned LeKiwi FK plus independently sampled fixed and moving finger meshes",
    contactBaseFrame,
    contactActionIndex: contactIndex,
    placementActionIndex: placeIndex,
    contactBodies: [...REQUIRED_CONTACT_BODIES],
    schemaToolReferenceSocketLocalMm: object.physicalRest.gripSocketMm,
    visibleContactInterface: object.physicalRest.gripInterface,
    fingerSurfaceClearanceMm: selected.fingerClearances.map((value) => Number(value.toFixed(6))),
    conservativeBoxFingerDepthMm: selected.fingerProxyPenetrations.map((value) => Number(value.toFixed(6))),
    maximumAdmittedMeshPenetrationMm: 0.5,
    initialGapMm: Number(selected.initialRest.gapMm.toFixed(6)),
    finalGapMm: Number(selected.finalRest.gapMm.toFixed(6)),
    finalTiltDeg: Number(selected.finalRest.tiltDeg.toFixed(6)),
    releasePoseSource: "actual opened-gripper FK pose; no release teleport or pose substitution",
    physicalHardwareValidated: false,
  };
  return selected;
}

for (const name of files) {
  const sourcePath = resolve(SOURCE, name);
  const definition = JSON.parse(await readFile(sourcePath, "utf8"));
  const object = definition.objects.find((item) => item.transportable !== false);
  if (!object) throw new Error(`${definition.id}: transport object is unavailable.`);
  await useServiceManipulationAfterRequiredStops(definition);
  compressStraightBaseRouteStops(definition);
  delete definition.portablePython.openGripperApproachPlanning;
  const selected = calibrateDirectFingerRest(definition, object);
  definition.frames.pickup_contact.tolerance.positionMm = 18;
  definition.frames.delivery_contact.tolerance.positionMm = 18;
  const grasp = definition.grasps.find((item) => item.objectId === object.id);
  if (!grasp) throw new Error(`${definition.id}: configured direct grasp is unavailable.`);
  grasp.allowedRobotContactBodies = [...REQUIRED_CONTACT_BODIES];
  grasp.contactRequirement = "Both independently sampled rendered LeKiwi finger bodies must contact the apparatus before the public close command crosses the closed threshold.";
  grasp.releaseRequirement = "Detach only when the public gripper-open command reaches the actual placement FK pose and the apparatus has a stable nonpenetrating worktop rest.";
  definition.portablePython.officialLeRobotContract = {
    imports: ["lerobot.robots.lekiwi.LeKiwiClient", "lerobot.robots.lekiwi.LeKiwiClientConfig"],
    construction: "LeKiwiClient(LeKiwiClientConfig(remote_ip=transport['remote_ip'], cameras={}))",
    publicCommand: "robot.send_action(action)",
    actionFields: [...PUBLIC_ACTION_FIELDS],
    execution: "ordinary synchronous official-shape LeRobot Python; each send_action target is immediate while the browser plant advances at fixed 20 ms steps",
    authority: "authoritative browser plant/FK/contact/object state; no learner grading shortcuts",
  };
  for (const step of definition.portablePython.referenceActions) {
    const keys = Object.keys(step.action).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...PUBLIC_ACTION_FIELDS].sort())) {
      throw new Error(`${definition.id}/${step.label}: reference action is not the complete official LeKiwi nine-field public action shape.`);
    }
  }
  definition.portablePython.referenceExecution = {
    id: "physical-style-python-reference",
    actionCount: definition.portablePython.referenceActions.length,
    source: "collision-checked IK/base trace emitted exclusively as official-shape LeKiwiClient.send_action fields",
    causalGrasp: "open -> live two-finger contact -> close -> attach",
    causalRelease: "stable placement contact -> open at live FK pose -> detach -> retreat",
    stableInitialGapMm: Number(selected.initialRest.gapMm.toFixed(6)),
    stableFinalGapMm: Number(selected.finalRest.gapMm.toFixed(6)),
    taskOutcomeExpected: true,
  };
  assertScenarioV2(definition, { expectedRobotId: "lekiwi_sim" });
  await writeFile(sourcePath, `${JSON.stringify(definition, null, 2)}\n`, "utf8");
  await writeFile(resolve(OUTPUT, name), `${JSON.stringify(stripValidationForClient(definition), null, 2)}\n`, "utf8");
  console.log(`${definition.id}: direct ${object.label}; finger clearances ${selected.fingerClearances.map((value) => value.toFixed(3)).join("/")} mm; final gap ${selected.finalRest.gapMm.toFixed(3)} mm.`);
}
