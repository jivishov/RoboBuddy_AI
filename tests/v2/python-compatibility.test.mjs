import assert from "node:assert/strict";
import { forwardKinematics } from "../../lab/v2/kinematics.js";
import { PortableRobotPlant, PORTABLE_PLANT_TICK_SECONDS } from "../../lab/v2/portable-robot-plant.js";
import { PYTHON_COMPATIBILITY_CATALOG, PYTHON_COMPATIBILITY_CLAIM } from "../../lab/v2/python-compatibility-catalog.js";
import { homeJointState, loadRobotModel } from "../../lab/v2/robot-model-catalog.js";

assert.equal(PYTHON_COMPATIBILITY_CATALOG.schema, "robobuddy.python-compatibility-catalog.v1");
assert.equal(PYTHON_COMPATIBILITY_CLAIM, "API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending.");
assert.equal(PYTHON_COMPATIBILITY_CATALOG.runtime.tickSeconds, 0.02);
assert.equal(PYTHON_COMPATIBILITY_CATALOG.profiles.so101.apiSource.revision, "7e241bd630a3719a56157a497ce5d08f244784f1");
assert.equal(PYTHON_COMPATIBILITY_CATALOG.profiles.lekiwi.geometrySource.revision, "efa608d7ee5a495a4803b1d28cd0c955b4f1e033");
assert.equal(PYTHON_COMPATIBILITY_CATALOG.profiles.openarm.controlSource.revision, "73ef89838763496b94da30ede38fc92218bea18e");
assert.equal(PYTHON_COMPATIBILITY_CATALOG.profiles.openarm.ros2SourcePatternProfile.exactLabel, "OpenArm ROS 2 source-pattern compatibility profile");

function stateFor(model) {
  return {
    runState: "ready",
    jointState: homeJointState(model),
    rootPose: { positionMm: [0, 0, 0], headingDeg: 0 },
    objects: {},
    processes: {},
    eventLog: [],
    commandLog: [],
  };
}

function definition(frames = {}, objects = []) {
  return { fixtures: [], frames, objects, processModels: [] };
}

const soModel = await loadRobotModel("so101_follower");
const soState = stateFor(soModel);
const soPlant = new PortableRobotPlant({ definition: definition(), model: soModel, runtimeState: soState });
assert.equal(soPlant.tickSeconds, PORTABLE_PLANT_TICK_SECONDS);
assert.throws(() => soPlant.connect("so", { cameras: { wrist: {} } }), (error) => error.code === "CAMERAS_UNSUPPORTED");
assert.equal(soPlant.connect("so", { cameras: {}, max_relative_target: null }), null);
const before = soPlant.getObservation("so");
const sent = soPlant.sendAction("so", { "shoulder_pan.pos": 12 });
assert.deepEqual(sent, { "shoulder_pan.pos": 12 });
assert.equal(soPlant.getObservation("so")["shoulder_pan.pos"], before["shoulder_pan.pos"], "send_action must return before the actual state reaches target");
soPlant.tick();
assert.ok(soPlant.getObservation("so")["shoulder_pan.pos"] > before["shoulder_pan.pos"]);
assert.ok(soPlant.getObservation("so")["shoulder_pan.pos"] < 12);
assert.throws(() => soPlant.sendAction("so", { "invented.pos": 1 }), (error) => error.code === "INVALID_ACTION_FIELD");

const sleep = soPlant.sleep(0.06);
soPlant.tick();
soPlant.pause();
const pausedAt = soPlant.clockNow();
soPlant.tick();
assert.equal(soPlant.clockNow(), pausedAt);
soPlant.resume();
soPlant.tick();
soPlant.tick();
await sleep;
assert.ok(soPlant.clockNow() >= 0.06);
soPlant.stop("test");
await assert.rejects(() => soPlant.sleep(0.02), (error) => error.code === "STOPPED");
const stoppedJoint = soState.jointState.shoulder_pan;
soPlant.tick();
assert.equal(soState.jointState.shoulder_pan, stoppedJoint);
soPlant.reset();
assert.equal(soPlant.clockNow(), 0);
assert.deepEqual(soState.jointState, homeJointState(soModel));

const contactState = stateFor(soModel);
contactState.jointState.gripper = 20;
const tool = forwardKinematics(soModel, contactState.jointState, { chainId: "default", basePose: contactState.rootPose }).positionMm;
contactState.objects.sample = {
  id: "sample",
  initialFrame: "sample_contact",
  currentFrame: "sample_contact",
  attachedTo: "",
  attachmentInterface: "",
  configuredAttachmentInterface: "gripper",
  compatibleEffectors: ["default"],
  physicalRest: {
    schema: "robobuddy.physical-rest.v1",
    gripSocketMm: [0, 0, 0],
    localUp: [0, 1, 0],
    geometry: { type: "box", centerLocalMm: [0, 0, 0], halfExtentsMm: [0, 0, 0] },
    tolerance: { maxTiltDeg: 180, maxGapMm: 0.5, maxPenetrationMm: 0.5, minimumEdgeMarginMm: 0, targetPositionToleranceMm: 0.5 },
    poses: {
      sample_contact: { surfaceId: "sample-worktop", positionMm: tool, rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      sample_destination: { surfaceId: "sample-worktop", positionMm: tool, rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    },
  },
  worldPositionMm: [...tool],
  worldRotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  state: {},
};
const contactDefinition = definition({
  sample_contact: { role: "contact", positionMm: tool, tolerance: { positionMm: 20 } },
  sample_destination: { role: "destination", positionMm: tool, tolerance: { positionMm: 20 } },
});
contactDefinition.fixtures = [{
  id: "sample-bench",
  collisionProxy: { id: "sample-worktop", type: "box", centerMm: [tool[0], tool[1] - 5, tool[2]], halfExtentsMm: [50, 5, 50], planningRole: "robot_mount_contact", physicalSupportSurface: true },
}];
const contactPlant = new PortableRobotPlant({ definition: contactDefinition, model: soModel, runtimeState: contactState });
contactPlant.connect("so", { cameras: {} });
contactPlant.sendAction("so", { "gripper.pos": 85 });
for (let index = 0; index < 40; index += 1) contactPlant.tick();
assert.equal(contactState.objects.sample.attachedTo, "", "a zero-volume proxy at FK must not fabricate opposing-finger surface contact");
assert.equal(contactState.eventLog.some((event) => event.type === "ATTACH_OBJECT"), false);

const lekiwiModel = await loadRobotModel("lekiwi_sim");
const lekiwiState = stateFor(lekiwiModel);
const lekiwiPlant = new PortableRobotPlant({ definition: definition(), model: lekiwiModel, runtimeState: lekiwiState });
lekiwiPlant.connect("lekiwi", { cameras: {} });
const lekiwiSent = lekiwiPlant.sendAction("lekiwi", { "x.vel": 0.2, "y.vel": 0.1, "theta.vel": 30 });
assert.equal(Object.keys(lekiwiSent.values).length, 9);
assert.equal(lekiwiSent.vector.length, 9);
for (let index = 0; index < 10; index += 1) lekiwiPlant.tick();
assert.ok(lekiwiState.rootPose.positionMm[0] > 0, "+X must move forward");
assert.ok(lekiwiState.rootPose.positionMm[2] < 0, "+Y left maps through the renderer boundary without changing public handedness");
assert.ok(lekiwiState.rootPose.headingDeg > 0, "positive yaw must be counter-clockwise in the public frame");
for (let index = 0; index < 16; index += 1) lekiwiPlant.tick();
assert.equal(lekiwiPlant.snapshot().watchdogActive, true, "500 ms watchdog must zero stale mobile commands");
assert.deepEqual(lekiwiPlant.snapshot().baseCommand, { x: 0, y: 0, thetaDeg: 0 });
assert.equal(lekiwiModel.configured.stowRequiredForDrive, false, "stow must not be a hidden plant action");
assert.equal(lekiwiModel.configured.stowPolicyVisibleToScenarioAndGrader, true);

const blockedBaseState = stateFor(lekiwiModel);
const blockedBaseDefinition = {
  ...definition(),
  fixtures: [{
    id: "fixed-base-obstacle",
    collisionProxy: { type: "box", centerMm: [130, 97, 0], halfExtentsMm: [5, 90, 80] }
  }]
};
const blockedBasePlant = new PortableRobotPlant({ definition: blockedBaseDefinition, model: lekiwiModel, runtimeState: blockedBaseState });
blockedBasePlant.connect("lekiwi", { cameras: {} });
blockedBasePlant.sendAction("lekiwi", { "x.vel": 0.4 });
for (let index = 0; index < 30 && !blockedBasePlant.fault; index += 1) blockedBasePlant.tick();
assert.equal(blockedBasePlant.fault?.code, "SIMULATOR_COLLISION_FAULT", "LeKiwi must collision-check its proposed base pose before committing motion");
assert.ok(blockedBaseState.rootPose.positionMm[0] < 20, "base collision retains the last valid root pose");

const openArmModel = await loadRobotModel("openarm_v2_bimanual");
const openArmState = stateFor(openArmModel);
const openArmPlant = new PortableRobotPlant({ definition: definition(), model: openArmModel, runtimeState: openArmState });
assert.throws(() => openArmPlant.connect("left", { side: "left", cameras: {}, use_velocity_and_torque: true }), (error) => error.code === "SENSING_UNSUPPORTED");
openArmPlant.connect("left", { side: "left", cameras: {}, use_velocity_and_torque: false, max_relative_target: null });
const clipped = openArmPlant.sendAction("left", { "joint_1.pos": 100, "gripper.pos": -65 });
assert.equal(clipped["joint_1.pos"], 75, "OpenArm must apply the upstream side joint-limit clipping");
assert.equal(clipped["gripper.pos"], -65);
assert.throws(() => openArmPlant.sendAction("left", { "joint_1.pos": 0 }, { customKp: { joint_1: 120 } }), (error) => error.code === "CUSTOM_GAINS_UNSUPPORTED");
openArmPlant.tick();
const openObservation = openArmPlant.getObservation("left");
assert.ok(openObservation["joint_1.pos"] > -75 && openObservation["joint_1.pos"] < 75);
assert.ok(openObservation["gripper.pos"] < 0);

console.log("portable Python compatibility catalog and fixed-step plant: PASS");
console.log("- immediate targets versus live observations; 20 ms clock; Pause/Resume/STOP/Reset");
console.log("- SO-101 schema/anti-fabrication; LeKiwi SE(2)/watchdog/collision; OpenArm clipping");
