import fs from "node:fs";
import path from "node:path";
import { stripValidationForClient } from "../lab/v2/scenario-schema.js";

const root = process.cwd();
const families = ["so101", "lekiwi", "openarm"];
const exactClaim = "API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending.";
const lekiwiRevision = "efa608d7ee5a495a4803b1d28cd0c955b4f1e033";
const legacyLeRobotRevision = "6adf51511b7625090eade8d82d9f61a1846ebe56";
const lerobotRevision = "7e241bd630a3719a56157a497ce5d08f244784f1";

function replacePinnedRevision(value) {
  if (typeof value === "string") return value.replaceAll(legacyLeRobotRevision, lerobotRevision);
  if (Array.isArray(value)) return value.map(replacePinnedRevision);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replacePinnedRevision(item)]));
  return value;
}

function sources() {
  return families.flatMap((family) => fs.readdirSync(path.join(root, "missions/lab-assistant/v2/definitions", family))
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(root, "missions/lab-assistant/v2/definitions", family, name)));
}

function defaultAction(robotId) {
  if (robotId === "so101_follower") return { "shoulder_pan.pos": 0, "shoulder_lift.pos": -90, "elbow_flex.pos": 85, "wrist_flex.pos": 72, "wrist_roll.pos": 0, "gripper.pos": 20 };
  if (robotId === "lekiwi_sim") return { "arm_shoulder_pan.pos": 0, "arm_shoulder_lift.pos": -90, "arm_elbow_flex.pos": 85, "arm_wrist_flex.pos": 72, "arm_wrist_roll.pos": 0, "arm_gripper.pos": 20, "x.vel": 0, "y.vel": 0, "theta.vel": 0 };
  return { "left_joint_1.pos": 0, "left_joint_2.pos": -20, "left_joint_3.pos": 0, "left_joint_4.pos": 30, "left_joint_5.pos": 0, "left_joint_6.pos": 0, "left_joint_7.pos": 0, "left_gripper.pos": -20, "right_joint_1.pos": 0, "right_joint_2.pos": 20, "right_joint_3.pos": 0, "right_joint_4.pos": 30, "right_joint_5.pos": 0, "right_joint_6.pos": 0, "right_joint_7.pos": 0, "right_gripper.pos": -20 };
}

function removeSymbolicCalls(entry) {
  const calls = Array.isArray(entry.calls) ? entry.calls : [];
  return {
    ...entry,
    calls: undefined,
    portableProgram: {
      runtime: "robobuddy.portable-python.v1",
      sourceStyle: "ordinary synchronous physical-style Python",
      migratedFromCallCount: calls.length,
      learnerGradingCalls: false,
    },
  };
}

function refine(definition) {
  definition = replacePinnedRevision(definition);
  const previousEvidence = definition.evidenceRequirements || [];
  const preservedHiddenRequirements = definition.hiddenGradingRequirements || [];
  const gradingRequirements = previousEvidence.length > 0 ? previousEvidence : preservedHiddenRequirements;
  if (gradingRequirements.length === 0) {
    throw new Error(`${definition.id}: portable migration cannot discard both learner evidence and its hidden authoritative plant/event requirements`);
  }
  definition.hiddenGradingRequirements = gradingRequirements.map((item) => ({ ...item, learnerCallable: false, authority: "plant/events" }));
  definition.evidenceRequirements = [];
  definition.api = { ...definition.api, runtime: "robobuddy.portable-python.v1" };
  delete definition.api.starterCalls;
  const retainedReferenceActions = definition.portablePython?.referenceActions?.length > 1
    ? definition.portablePython.referenceActions.map((step) => ({ ...step }))
    : null;
  definition.portablePython = {
    ...(definition.portablePython || {}),
    version: 1,
    claim: exactClaim,
    execution: "whole synchronous script with __name__ == '__main__'",
    compatibilityModules: "browser-provided modules under exact public import paths; not upstream hardware packages",
    externalProfiles: ["transport.json", "workcell.json"],
    referenceActions: retainedReferenceActions
      ? retainedReferenceActions
      : [{ label: "configured safe reference", action: defaultAction(definition.robotId), hold_seconds: 1 }],
    gradingAuthority: "authoritative fixed-step plant, FK contact, object, fixture, and event state only",
    learnerGradingCalls: false,
    unsupported: ["dynamics and controller emulation", "physical transport/calibration/sensing", "hardware certification and validation"],
  };
  definition.fixtures = definition.fixtures.map((fixture) => {
    const contactFrameId = fixture.supportsFrame || fixture.atFrame || "";
    if (definition.frames?.[contactFrameId]?.role !== "contact") return fixture;
    if (fixture.collisionProxy) fixture.collisionProxy = { ...fixture.collisionProxy, planningRole: "contact_surface" };
    if (Array.isArray(fixture.collisionProxies)) fixture.collisionProxies = fixture.collisionProxies.map((proxy) => ({ ...proxy, planningRole: proxy.planningRole || "contact_surface" }));
    return fixture;
  });
  if (definition.robotId === "lekiwi_sim") {
    definition.canonicalModel.sourceRevision = lekiwiRevision;
    definition.modelClaim.source = {
      kind: "official URDF baked model",
      revision: lekiwiRevision,
      url: `https://github.com/SIGRobotics-UIUC/LeKiwi/blob/${lekiwiRevision}/URDF/LeKiwi.urdf`,
      provenance: "M",
      notes: "Immutable reviewed official visual/kinematic chain; planar response and collision bounds are configured separately.",
    };
  }
  definition.modelClaim.supportedFidelity = "Reference-calibrated kinematic digital model where source-pinned; configured response values are labeled separately";
  definition.modelClaim.unsupportedPhysics = [
    "motor/controller dynamics, inertia, gravity load, friction, compliance, backlash, thermal/current/voltage behavior",
    "physical transport, calibration, cameras/sensing, ROS/DDS, datasets, policies, training, force/torque control",
    "payload, collision avoidance, hardware validation, and safety certification",
  ];
  definition.validation.referenceExecutions = definition.validation.referenceExecutions.map(removeSymbolicCalls);
  definition.validation.acceptedAlternates = definition.validation.acceptedAlternates.map(removeSymbolicCalls);
  definition.validation.negativeCases = definition.validation.negativeCases.map((entry) => ({ ...removeSymbolicCalls(entry), portableNegative: true }));
  if (!definition.provenance.some((entry) => entry.claim === exactClaim)) definition.provenance.push({ label: "R", claim: exactClaim });
  return definition;
}

for (const source of sources()) {
  const definition = refine(JSON.parse(fs.readFileSync(source, "utf8")));
  fs.writeFileSync(source, `${JSON.stringify(definition, null, 2)}\n`);
  const output = path.join(root, "missions/lab-assistant/v2/generated/scenarios", `${definition.id}.json`);
  fs.writeFileSync(output, `${JSON.stringify(stripValidationForClient(definition), null, 2)}\n`);
}

const indexPath = path.join(root, "missions/lab-assistant/v2/index.json");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
index.tasks = index.tasks.map((task) => !["so101_follower", "lekiwi_sim", "openarm_v2_bimanual"].includes(task.robotId) ? task : {
  ...task,
  supportedFidelity: "Reference-calibrated kinematic digital model where source-pinned; configured response values are labeled separately",
  limitations: "dynamics/controller equivalence; physical transport, calibration, sensing, ROS/DDS; payload, hardware validation, and safety certification",
});
fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

console.log(`Refined ${sources().length} SO-101, LeKiwi, and OpenArm portable-Python scenario sources and generated clients.`);
