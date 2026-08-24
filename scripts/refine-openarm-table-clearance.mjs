import fs from "node:fs";
import path from "node:path";
import { assertScenarioV2, stripValidationForClient } from "../lab/v2/scenario-schema.js";
import { loadRobotModel, modelClaim } from "../lab/v2/robot-model-catalog.js";
import {
  apparatusVisualProfile,
  directApparatusVisual,
  directHandlingLabel,
  directGripHeightMm,
  IDENTITY_ROTATION,
  physicalRest,
  YAW_180_ROTATION,
} from "./portable-physical-rest-helpers.mjs";

const root = process.cwd();
const sourceDir = path.join(root, "missions/lab-assistant/v2/definitions/openarm");
const outputDir = path.join(root, "missions/lab-assistant/v2/generated/scenarios");
const approachClearanceMm = 180;
const watchGlassApproachClearanceMm = 120;
const carriedClearanceMm = 120;
await loadRobotModel("openarm_v2_bimanual");
const OPENARM_MODEL_CLAIM = modelClaim("openarm_v2_bimanual");
const OPENARM_LEFT_STOW_TOOL_MM = Object.freeze([340.767356731, 548.285384142, -179.854376863]);
const OPENARM_DIRECT_PROFILE_OVERRIDES = Object.freeze({
  "openarm-01-weighing-handoff": { right: "bottle" },
  "openarm-03-cuvette-handoff": { right: "cuvette" },
  "openarm-04-filtration-workcell": { left: "filter_flask", right: "wash_bottle" },
  "openarm-05-titration-workcell": { right: "bottle" },
  "openarm-06-cooling-handoff": { right: "cuvette" },
  "openarm-07-chromatography-workcell": { left: "bottle", right: "volumetric_flask" },
  "openarm-09-standardization-workcell": { right: "volumetric_flask" },
  "openarm-10-gravimetric-workcell": { right: "wash_bottle" },
});

function sideObject(definition, side) {
  return definition.objects.find((object) => (object.allowedEffectors || object.compatibleEffectors || []).includes(side));
}

function replaceStringEverywhere(value, replacements) {
  if (typeof value === "string") return replacements.reduce((text, [from, to]) => text.split(from).join(to), value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => { value[index] = replaceStringEverywhere(entry, replacements); });
    return value;
  }
  if (value && typeof value === "object") {
    Object.keys(value).forEach((key) => { value[key] = replaceStringEverywhere(value[key], replacements); });
  }
  return value;
}

function refine(definition) {
  definition.modelClaim = structuredClone(OPENARM_MODEL_CLAIM);
  definition.fixtures = definition.fixtures.filter((fixture) => fixture.type !== "configured_cork_support_ring");
  const workcell = definition.fixtures.find((fixture) => fixture.type === "configured_visible_bimanual_workcell");
  if (!workcell) throw new Error(`${definition.id}: configured bimanual workcell is unavailable.`);
  const worktops = (workcell.collisionProxies || []).filter((proxy) => String(proxy.id).endsWith("worktop"));
  if (worktops.length !== 2) throw new Error(`${definition.id}: expected two configured worktops.`);
  worktops.forEach((surface) => {
    surface.planningRole = "contact_surface";
    surface.physicalSupportSurface = true;
    surface.provenance = `${surface.provenance?.split("; physical support")[0] || "C: configured visible worktop"}; physical support surface shared by authoritative rest validation and presentation`;
  });
  const worktopTopY = Math.max(...worktops.map((proxy) => Number(proxy.centerMm[1]) + Number(proxy.halfExtentsMm[1])));
  definition.frames.home.positionMm = [...OPENARM_LEFT_STOW_TOOL_MM];
  definition.frames.home.chainId = "left";
  definition.frames.home.tolerance.positionMm = 2;
  const contactToolCenterY = {};
  const transitToolCenterY = {};

  for (const side of ["left", "right"]) {
    const object = sideObject(definition, side);
    if (!object) throw new Error(`${definition.id}: ${side} transport object is unavailable.`);
    const configuredProfile = OPENARM_DIRECT_PROFILE_OVERRIDES[definition.id]?.[side];
    if (configuredProfile) {
      object.configuredApparatusProfile = configuredProfile;
      object.roleRedesign = "The prior low-profile object required an inaccessible tabletop underside pinch. This source-owned role now uses upright, directly graspable laboratory apparatus without moving the worktop, floating the payload, adding a carrier, or weakening collision.";
    } else {
      delete object.configuredApparatusProfile;
      delete object.roleRedesign;
    }
    const apparatus = apparatusVisualProfile(object);
    const oldId = object.id;
    const oldLabel = object.label;
    const directId = `${side}_${apparatus.type}`;
    replaceStringEverywhere(definition, [[oldId, directId], [oldLabel, apparatus.directLabel]]);
    const rotation = side === "right" ? YAW_180_ROTATION : IDENTITY_ROTATION;
    object.label = directHandlingLabel(object);
    object.visual = directApparatusVisual(object);
    object.configuredGripInterface = `${apparatus.gripInterface}; direct contact with the intended apparatus, with no tray, carrier, cassette, bin, or proxy payload.`;
    object.attachmentInterface = "direct_apparatus_grip";
    for (const grasp of definition.grasps || []) {
      if (grasp.objectId !== object.id) continue;
      grasp.mode = "direct-apparatus";
      grasp.attachmentInterface = "direct_apparatus_grip";
      grasp.contactInterface = apparatus.gripInterface;
      grasp.allowedRobotContactBodies = [`${side}_finger_inner`, `${side}_finger_outer`];
    }
    const initialSurfaceId = `${side}-worktop`;
    const finalSurfaceId = `${side}-worktop`;
    if (apparatus.type === "watch_glass") {
      // Keep the centre of mass and more than the configured stable fraction
      // on the unchanged worktop. Only the inner rim overhangs, providing real
      // lower-finger clearance for a direct edge pinch without a holder.
      for (const suffix of ["approach", "contact", "lift", "handoff", "place_contact", "retreat"]) definition.frames[`${side}_${suffix}`].positionMm[0] = 140;
      for (const suffix of ["approach", "contact", "lift"]) definition.frames[`${side}_${suffix}`].positionMm[2] = -430;
      for (const suffix of ["handoff", "place_contact", "retreat"]) definition.frames[`${side}_${suffix}`].positionMm[2] = -340;
      definition.frames[`${side}_contact`].contactFixtureId = "weighing_handoff_pad";
      definition.frames[`${side}_place_contact`].contactFixtureId = "weighing_handoff_pad";
    } else {
      definition.frames[`${side}_contact`].contactFixtureId = "weighing_handoff_pad";
      definition.frames[`${side}_place_contact`].contactFixtureId = "weighing_handoff_pad";
    }
    const gripY = worktopTopY + directGripHeightMm(object);
    const approachY = gripY + (apparatus.type === "watch_glass" ? watchGlassApproachClearanceMm : approachClearanceMm);
    const transitY = gripY + carriedClearanceMm;
    contactToolCenterY[side] = gripY;
    transitToolCenterY[side] = transitY;

    for (const suffix of ["contact", "place_contact"]) {
      definition.frames[`${side}_${suffix}`].positionMm[1] = gripY;
      definition.frames[`${side}_${suffix}`].tolerance.positionMm = 2;
    }
    definition.frames[`${side}_approach`].positionMm[1] = approachY;
    definition.frames[`${side}_approach`].tolerance.positionMm = 5;
    for (const suffix of ["lift", "handoff", "retreat"]) {
      definition.frames[`${side}_${suffix}`].positionMm[1] = transitY;
      definition.frames[`${side}_${suffix}`].tolerance.positionMm = 5;
    }
    object.physicalRest = physicalRest({
      definition,
      item: object,
      surfaceId: `${side}-worktop`,
      initialSurfaceId,
      finalSurfaceId,
      initialFrame: object.initialFrame,
      initialGripFrame: `${side}_contact`,
      finalFrame: `${side}_handoff`,
      finalGripFrame: `${side}_place_contact`,
      initialRotation: rotation,
      finalRotation: rotation,
    });
  }

  definition.fixtures = definition.fixtures.filter((fixture) => fixture.type !== "configured_visible_support_pad");
  workcell.claimBoundary = "The two low worktops and floor-anchored legs are teacher-visible authored configuration. Intended lab items, including the level watch glass, rest directly and stably on the real worktops with no auxiliary holder, stick, post, pin, pedestal, carrier, or hidden support. Presentation, authoritative rest validation, and collision use the same configured geometry. No calibration, force, payload, dynamics, or physical-safety claim is made.";
  definition.coordination.presentation = {
    objectAnchor: "authoritative_world_pose",
    supportFoundation: "floor_anchored_table",
    frameLabels: "contact_markers_only",
    worktopTopMm: worktopTopY,
    geometrySource: "authored_collision_proxies_and_physical_rest",
  };
  definition.coordination.tableClearance = {
    authority: "authoritative fixed-step plant and renderer consume the same object world pose and configured worktop boxes",
    transitToolCenterY: Math.max(...Object.values(transitToolCenterY)),
    transitToolCenterYBySide: transitToolCenterY,
    contactToolCenterY: contactToolCenterY,
    contactSurfaceClearanceMm: 0,
    stagingApparatus: "intended laboratory equipment grasped directly at its declared apparatus-specific socket; the level watch glass rests directly on the real worktop with its centre of mass and configured stable footprint fraction supported",
    forbiddenReachabilityAids: ["transport trays", "proxy carriers", "registration pins", "thin rods", "pedestals", "hidden supports", "tilted resting payloads"],
    basis: "The apparatus footprint is horizontal and supported on the worktop; the robot contacts the rendered equipment directly and maintains world-up during lift, transfer, placement, opening, and retreat.",
    dynamicsClaimed: false,
  };
  definition.coordination.initialStow = {
    base_yaw: 0,
    left_j1: -5, left_j2: -40, left_j3: 0, left_j4: 120, left_j5: 0, left_j6: -5, left_j7: 0, left_gripper: 45,
    right_j1: 5, right_j2: 40, right_j3: 0, right_j4: 120, right_j5: 0, right_j6: 5, right_j7: 0, right_gripper: 45,
    claim: "Configured symmetric task-ready stow with open fingers, fixed base yaw, zero J5/J7, and both distal arms clear of every initial apparatus envelope.",
  };
  const directLabels = definition.objects.filter((item) => item.transportable !== false).map((item) => item.label.toLowerCase());
  if (definition.migration?.redesignRationale) {
    definition.migration.redesignRationale = `The v2 task preserves observable bimanual coordination while assigning both arms to directly handled ${directLabels[0]} and ${directLabels[1]}; unmodeled fluid and laboratory-process claims remain outside scope. Physical-rest repair: direct apparatus handling on real worktops replaces pin-supported or container-mediated payloads so reachability does not depend on invented support geometry.`;
  }
  definition.brief = `Coordinate direct handling of ${directLabels[0]} and ${directLabels[1]} through separate, observable left/right approach, grasp, lift, transfer, placement, release, and retreat sequences.`;
  for (const process of definition.processModels || []) {
    if (typeof process.label === "string") process.label = `Confirm ${directLabels[0]} and ${directLabels[1]} occupy their configured workcell positions.`;
  }
  return definition;
}

const files = fs.readdirSync(sourceDir).filter((name) => name.endsWith(".json")).sort();
if (files.length !== 10) throw new Error(`Expected 10 OpenArm definitions; found ${files.length}.`);
for (const name of files) {
  const sourcePath = path.join(sourceDir, name);
  const definition = refine(JSON.parse(fs.readFileSync(sourcePath, "utf8")));
  assertScenarioV2(definition, { expectedRobotId: "openarm_v2_bimanual" });
  fs.writeFileSync(sourcePath, `${JSON.stringify(definition, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, name), `${JSON.stringify(stripValidationForClient(definition), null, 2)}\n`);
  console.log(`${definition.id}: authored direct apparatus grips and stable worktop rest poses without transport containers`);
}
