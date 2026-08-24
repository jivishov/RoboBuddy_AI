import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRobotModel, modelClaim } from "../lab/v2/index.js";
import { assertScenarioV2, stripValidationForClient } from "../lab/v2/scenario-schema.js";
import { SO101_COMMAND_MODEL } from "../lab/v2/so101-command-model.js";
import { radialSurfaceRadiusAtHeight } from "../lab/v2/apparatus-geometry.js";
import {
  apparatusVisualProfile,
  directApparatusVisual,
  directHandlingLabel,
  IDENTITY_ROTATION,
  objectOriginForGrip,
  physicalRest,
  realWorkSurfaceProxy,
} from "./portable-physical-rest-helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "so101");
const OUTPUT = resolve(ROOT, "missions", "lab-assistant", "v2", "generated", "scenarios");
const files = (await readdir(SOURCE)).filter((name) => name.endsWith(".json")).sort();
if (files.length !== 10) throw new Error(`Expected 10 SO-101 definitions; found ${files.length}.`);

const model = await loadRobotModel("so101_follower");
const claim = modelClaim("so101_follower");
const SO101_CONTACT_GEOMETRY = SO101_COMMAND_MODEL.gripper.contactGeometry;

function pinchHalfExtentAtHeight(geometry, heightMm) {
  if (Array.isArray(geometry.radialProfileMm)) {
    const renderedRadiusMm = radialSurfaceRadiusAtHeight(geometry.radialProfileMm, heightMm);
    if (Number.isFinite(renderedRadiusMm) && renderedRadiusMm > 0) return renderedRadiusMm;
  }
  const centralSections = (geometry.collisionParts || []).filter((part) => (
    Array.isArray(part.centerLocalMm)
    && Array.isArray(part.halfExtentsMm)
    && Math.abs(Number(part.centerLocalMm[0])) <= Number(part.halfExtentsMm[0]) + 1e-6
    && Number(heightMm) >= Number(part.centerLocalMm[1]) - Number(part.halfExtentsMm[1]) - 1e-6
    && Number(heightMm) <= Number(part.centerLocalMm[1]) + Number(part.halfExtentsMm[1]) + 1e-6
  ));
  return Math.max(0, ...centralSections.map((part) => Number(part.halfExtentsMm[0])))
    || Number(geometry.halfExtentsMm[0]);
}

// Flat paper, open weigh boats, long capillaries, horizontal burettes, and
// unsupported funnels cannot be picked directly from a level bench by the
// SO-101 without driving the wrist/jaw through the worktop or inventing a
// pedestal.  Keep the legacy object ids for migration compatibility, but
// redesign those task roles around genuine upright lab apparatus whose
// configured grip surfaces and stable footprints fit the physical arm.
const SO101_DIRECT_PROFILE_OVERRIDES = Object.freeze({
  "so101-v2-01-weigh-boat": Object.freeze({ weigh_boat: "bottle" }),
  "so101-v2-02-mixing-station": Object.freeze({ volumetric_flask: "beaker" }),
  "so101-v2-03-cuvette-orientation": Object.freeze({ sample_cuvette: "bottle" }),
  "so101-v2-04-filter-assembly": Object.freeze({
    filter_paper_carrier: "bottle",
    filter_flask: "beaker",
  }),
  "so101-v2-06-quantitative-transfer": Object.freeze({
    sealed_aliquot_carrier: "bottle",
    capped_rinse_bottle: "bottle",
  }),
  "so101-v2-07-chromatography-spotting": Object.freeze({ capped_spotting_tool: "bottle" }),
  "so101-v2-08-burette-initial-reading": Object.freeze({
    capped_burette_carrier: "bottle",
    funnel_carrier: "beaker",
  }),
  "so101-v2-09-vacuum-filtration": Object.freeze({
    sealed_buchner_carrier: "bottle",
    sealed_filter_carrier: "beaker",
  }),
});

const SO101_TASK_TITLES = Object.freeze({
  "so101-v2-01-weigh-boat": "Reagent Bottle Placement",
  "so101-v2-02-mixing-station": "Reagent Bottle and Beaker Staging",
  "so101-v2-03-cuvette-orientation": "Sample Bottle Queue Placement",
  "so101-v2-04-filter-assembly": "Filtration Glassware Staging",
  "so101-v2-06-quantitative-transfer": "Transfer Bottle and Rinse Station Readiness",
  "so101-v2-07-chromatography-spotting": "Chromatography Solvent Bottle Staging",
  "so101-v2-08-burette-initial-reading": "Titration Glassware Setup Queue",
  "so101-v2-09-vacuum-filtration": "Vacuum Filtration Glassware Staging",
});

// Scenario ids remain stable catalog keys, but legacy object/frame ids must not
// leak obsolete carriers, adapters, or substituted apparatus names into the
// live status display (which humanizes ids).  Migrate every owning reference
// together so contact, grading, attachment, and generated-action links remain
// causal and referentially complete.
const SO101_IDENTIFIER_MIGRATIONS = Object.freeze({
  "so101-v2-01-weigh-boat": Object.freeze({ weigh_boat: "reagent_bottle" }),
  "so101-v2-02-mixing-station": Object.freeze({ volumetric_flask: "empty_beaker" }),
  "so101-v2-03-cuvette-orientation": Object.freeze({ sample_cuvette: "sample_bottle" }),
  "so101-v2-04-filter-assembly": Object.freeze({
    filter_paper_carrier: "filtration_reagent_bottle",
    filter_flask: "filtration_beaker",
  }),
  "so101-v2-06-quantitative-transfer": Object.freeze({ sealed_aliquot_carrier: "aliquot_bottle" }),
  "so101-v2-07-chromatography-spotting": Object.freeze({ capped_spotting_tool: "chromatography_solvent_bottle" }),
  "so101-v2-08-burette-initial-reading": Object.freeze({
    capped_burette_carrier: "titrant_bottle",
    funnel_carrier: "titration_beaker",
  }),
  "so101-v2-09-vacuum-filtration": Object.freeze({
    sealed_buchner_carrier: "filtration_reagent_bottle",
    sealed_filter_carrier: "filtration_beaker",
  }),
});

const SO101_USER_TEXT_REPLACEMENTS = Object.freeze({
  "so101-v2-01-weigh-boat": [[/weigh[- ]?boat/gi, "capped reagent bottle"]],
  "so101-v2-02-mixing-station": [[/(?:empty )?volumetric flask/gi, "empty beaker"]],
  "so101-v2-03-cuvette-orientation": [[/(?:capped )?sample cuvette|cuvette/gi, "capped sample bottle"]],
  "so101-v2-04-filter-assembly": [
    [/(?:dry )?filter[- ]paper/gi, "capped sample bottle"],
    [/(?:empty )?filter flask/gi, "empty filtration beaker"],
  ],
  "so101-v2-06-quantitative-transfer": [[/(?:capped\s+)*(?:sealed\s+)?aliquot(?:\s+(?:cuvette|carrier|bottle|apparatus))*/gi, "capped aliquot bottle"]],
  "so101-v2-07-chromatography-spotting": [[/(?:capped )?spotting (?:capillary|tool)|capillary/gi, "capped chromatography solvent bottle"]],
  "so101-v2-08-burette-initial-reading": [
    [/(?:capped )?(?:dry-practice )?burette/gi, "capped titrant bottle"],
    [/(?:dry )?gravity funnel|funnel/gi, "empty beaker"],
    [/(?:dry filling-)?(?:empty )?volumetric flask(?: apparatus)?/gi, "empty beaker"],
  ],
  "so101-v2-09-vacuum-filtration": [
    [/(?:dry )?Buchner[- ]funnel/gi, "capped filtration reagent bottle"],
    [/(?:dry )?filter[- ]paper/gi, "empty filtration beaker"],
  ],
});

function rewriteUserFacingText(value, replacements = []) {
  if (Array.isArray(value)) return value.map((item) => rewriteUserFacingText(item, replacements));
  if (!value || typeof value !== "object") return value;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && [
      "title", "label", "brief", "description", "semantic", "claim",
      "instruction", "message", "redesignRationale", "contents",
      "approximation", "provenance", "roleRedesign", "releaseRequirement",
      "legacyLearningObjective",
    ].includes(key)) {
      value[key] = replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), child)
        .replace(/carrier handles?/gi, "configured apparatus grip surfaces")
        .replace(/carrier fixture/gi, "workbench staging zone")
        .replace(/carriers?/gi, "apparatus")
        .replace(/destination slots?/gi, "receiving zones")
        .replace(/pickup adapters?/gi, "pickup work surfaces")
        .replace(/grip adapters?/gi, "direct grip")
        .replace(/queue cassettes?/gi, "work-surface receiving queue")
        .replace(/visible narrow-tab adapters, destination supports/gi, "configured direct-apparatus grasp frames and broad receiving work surfaces");
    } else if (child && typeof child === "object") rewriteUserFacingText(child, replacements);
  }
  return value;
}

function migrateIdentifiers(value, migrations) {
  if (Array.isArray(value)) return value.map((item) => migrateIdentifiers(item, migrations));
  if (!value || typeof value !== "object") return value;
  for (const [key, child] of Object.entries(value)) {
    const migratedKey = Object.entries(migrations).reduce((text, [legacyId, directId]) => text.replaceAll(legacyId, directId), key);
    if (migratedKey !== key) {
      delete value[key];
      value[migratedKey] = child;
    }
    if (typeof child === "string") {
      value[migratedKey] = Object.entries(migrations).reduce((text, [legacyId, directId]) => text.replaceAll(legacyId, directId), child);
    } else if (child && typeof child === "object") {
      migrateIdentifiers(child, migrations);
    }
  }
  return value;
}

function normalizeObjectGoalLabels(definition) {
  for (const goal of definition.goalPredicates || []) {
    if (!goal.objectId) continue;
    const object = definition.objects.find((item) => item.id === goal.objectId);
    if (!object) continue;
    if (goal.op === "object_at") {
      goal.label = `${object.label} visibly seated stably on its named receiving work-surface zone`;
      continue;
    }
    if (goal.op !== "frame_visited") continue;
    const phase = ["approach", "contact", "lift", "retreat"].find((item) => String(goal.frameId || "").endsWith(`_${item}`));
    if (phase) goal.label = `${phase[0].toUpperCase()}${phase.slice(1)} frame visited for ${object.label}`;
  }
}

function configureSurface(fixture, object, frame, role, objectRotation = IDENTITY_ROTATION) {
  const origin = objectOriginForGrip(frame.positionMm, objectRotation, object.visual.gripSocketMm);
  fixture.label = `${role === "pickup" ? "Pickup" : "Receiving"} work-surface zone for ${object.label}`;
  fixture.visible = true;
  fixture.type = "configured_real_work_surface";
  fixture.configured = true;
  fixture.sourceBackedHolder = true;
  fixture.atFrame = role === "pickup" ? object.initialFrame : `${object.id}_place_contact`;
  fixture.positionMm = [origin[0], 0, origin[2]];
  fixture.collisionProxies = [realWorkSurfaceProxy(
    `${fixture.id}-worktop`,
    [origin[0], -12, origin[2]],
    role === "pickup" ? [98, 12, 80] : [115, 12, 115],
    role === "pickup"
      ? "C: configured 196 x 160 mm real-workbench staging zone centered beneath the level directly handled apparatus; adjacent objects retain a physical gap"
      : "C: configured 230 x 230 mm real-workbench receiving zone centered beneath the directly handled apparatus; the reference extractor expands only this receiving footprint metadata when the collision-checked release yaw requires it"
  )];
  delete fixture.collisionProxy;
  delete fixture.supportsFrame;
  fixture.description = "A broad, level section of the real workbench supports the complete lab-apparatus footprint. It is not a pin, post, tab, pedestal, container, or reachability aid; the SO-101 contacts the rendered apparatus directly.";
  return fixture.collisionProxies[0].id;
}

for (const name of files) {
  const sourcePath = resolve(SOURCE, name);
  const definition = JSON.parse(await readFile(sourcePath, "utf8"));
  definition.canonicalModel.sourceRevision = model.source.revision;
  definition.modelClaim = claim;
  definition.api.physicalProgrammability = {
    commandSurface: "LeRobot SOFollower send_action/get_observation position fields",
    actionKeys: [...SO101_COMMAND_MODEL.actionKeys],
    jointOrder: [...SO101_COMMAND_MODEL.jointOrder],
    bodyUnit: "deg",
    gripperUnit: "normalized_0_100",
    directActionShape: "one or more recognized <joint>.pos fields; Blockly emits all six for explicit educational state",
    alternativeBodyNormalizationModeled: false,
    maxRelativeTargetClippingModeled: false,
    simulationRestIsPhysicalHome: false,
    deviceCalibrationValidated: false,
    learnerProgramContract: "ordinary synchronous Python imports the pinned public lerobot.robots.so_follower SO101Follower/SO101FollowerConfig aliases and calls connect, send_action, get_observation, and disconnect",
    offlineReferencePlanning: "reference joint targets are generated from the configured URDF/mesh model and collision checked; no Cartesian or skills helper is exposed as a physical SOFollower method",
  };
  definition.portablePython.officialPython = {
    importPath: "lerobot.robots.so_follower",
    robotClass: "SO101Follower",
    configClass: "SO101FollowerConfig",
    actionMethod: "send_action",
    observationMethod: "get_observation",
    synchronous: true,
    sourceRevision: SO101_COMMAND_MODEL.sources.lerobot.revision,
    browserBoundary: "API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending.",
  };

  const modelProvenance = definition.provenance.find((entry) => entry.label === "M");
  if (modelProvenance) {
    modelProvenance.claim = "The mesh hierarchy and body-joint mechanical limits follow the pinned official SO-101 URDF; the position field names, order, default degree mode, gripper normalization, and partial direct-action behavior follow the pinned LeRobot SOFollower implementation.";
    modelProvenance.sourceRef = `${SO101_COMMAND_MODEL.sources.urdf.url} | ${SO101_COMMAND_MODEL.sources.lerobot.robotUrl}`;
  }
  const configured = definition.provenance.find((entry) => entry.label === "C");
  if (configured) configured.claim = "Object-specific frames, real work-surface dimensions, visual scales, tolerances, collision envelopes, and readiness states are configured educational values. Each intended lab item rests directly and stably on a declared real workbench zone and is grasped at its configured rim, neck, body, shaft, edge, or rack side; no transport container, synthetic support, or hidden reachability aid is used.";

  for (const object of definition.objects) {
    const override = SO101_DIRECT_PROFILE_OVERRIDES[definition.id]?.[object.id];
    if (override) {
      object.configuredApparatusProfile = override;
      object.roleRedesign = "The original low-profile or unsupported item could not be approached and lifted directly by the SO-101 without worktop penetration or an invented support. This configured role uses genuine upright lab apparatus with a stable footprint and reachable direct grip surface.";
    }
  }
  migrateIdentifiers(definition, SO101_IDENTIFIER_MIGRATIONS[definition.id] || {});
  for (const [objectIndex, object] of definition.objects.entries()) {
    const approachId = `${object.id}_approach`;
    const contactId = `${object.id}_contact`;
    const liftId = `${object.id}_lift`;
    const destinationId = `${object.id}_destination`;
    const placeId = `${object.id}_place_contact`;
    const retreatId = `${object.id}_retreat`;
    const contact = definition.frames[contactId];
    const destination = definition.frames[destinationId];
    if (!contact || !destination) throw new Error(`${definition.id}/${object.id}: configured transport frames are unavailable.`);
    const existingPlace = definition.frames[placeId] || destination;
    const apparatus = apparatusVisualProfile(object);
    const halfExtentsMm = apparatus.geometry.halfExtentsMm;
    const topClearanceMm = apparatus.type === "bottle" ? 20 : 30;
    const collisionClearGripHeightMm = apparatus.type === "bottle" && apparatus.variant === "reagent_bottle"
      ? 85
      : apparatus.type === "flask" && apparatus.variant === "erlenmeyer"
        ? 96
        : Math.max(Number(apparatus.gripSocketMm[1]), Number(apparatus.heightMm) - topClearanceMm);
    const contactHalfExtentMm = pinchHalfExtentAtHeight(apparatus.geometry, collisionClearGripHeightMm);
    const configuredGripInterface = apparatus.type === "flask" && apparatus.variant === "erlenmeyer"
      ? "direct neck pinch below the rim"
      : apparatus.gripInterface;
    const radialAngle = Math.atan2(Number(contact.positionMm[2]), Number(contact.positionMm[0]));
    const approachAngle = radialAngle - (97 * Math.PI / 180);
    const toolAxisTarget = [Math.cos(approachAngle), 0, Math.sin(approachAngle)];
    const objectAxisX = toolAxisTarget.map((value) => -value);
    const objectRotation = [
      objectAxisX[0], 0, -objectAxisX[2],
      0, 1, 0,
      objectAxisX[2], 0, objectAxisX[0],
    ];
    const gripSocketMm = [
      contactHalfExtentMm + Number(SO101_CONTACT_GEOMETRY.fixedWitnessInToolFrameMm[0]),
      collisionClearGripHeightMm,
      0,
    ];
    object.label = directHandlingLabel(object);
    object.visual = directApparatusVisual(object);
    object.visual.gripSocketMm = [...gripSocketMm];
    object.visual.approximation = `C: configured ${object.label.toLowerCase()} renderer envelope (${object.visual.footprintMm[0]} x ${object.visual.heightMm} x ${object.visual.footprintMm[1]} mm); the opposing gripper fingers contact this apparatus directly.`;
    object.configuredGripInterface = `${configuredGripInterface}; opposing rendered finger contact with the intended apparatus itself.`;
    object.attachmentInterface = "direct_apparatus_grip";
    delete object.visualScaleProvenance;

    const gripHeightMm = gripSocketMm[1];
    const otherApparatusHeightMm = Math.max(0, ...definition.objects
      .filter((_other, otherIndex) => otherIndex !== objectIndex)
      .map((other) => apparatusVisualProfile(other).heightMm));
    const clearanceToolHeightMm = gripHeightMm + Math.max(100, otherApparatusHeightMm + 12);
    contact.positionMm[1] = gripHeightMm;
    contact.directionConstraint = {
      localVector: [...SO101_CONTACT_GEOMETRY.axisInToolFrame],
      targetVector: [...toolAxisTarget],
      toleranceDeg: SO101_CONTACT_GEOMETRY.alignmentToleranceDeg,
      weightMmPerRad: 180,
    };
    if (definition.frames[approachId]) {
      definition.frames[approachId].positionMm[0] = contact.positionMm[0];
      definition.frames[approachId].positionMm[2] = contact.positionMm[2];
      definition.frames[approachId].directionConstraint = { ...contact.directionConstraint };
      delete definition.frames[approachId].semantic;
    }
    contact.tolerance = { ...(contact.tolerance || {}), positionMm: 1.5 };
    contact.visitToleranceMm = 22;
    existingPlace.positionMm[1] = gripHeightMm;
    definition.frames[placeId] = {
      ...existingPlace,
      role: "contact",
      chainId: destination.chainId || "default",
      tolerance: { ...destination.tolerance },
      contactFixtureId: `${object.id}_destination_slot`,
      coincidentWith: destinationId,
      semantic: "Physical direct-apparatus placement contact; the item's real footprint rests on the broad receiving workbench zone.",
    };
    destination.positionMm = [existingPlace.positionMm[0], clearanceToolHeightMm, existingPlace.positionMm[2]];
    destination.semantic = "Semantic transfer frame above the tallest configured resting apparatus plus the carried item's complete lower envelope and a 24 mm physical clearance; release occurs only at the distinct placement-contact frame.";
    delete destination.contactFixtureId;
    for (const frameId of [approachId, liftId, retreatId]) {
      if (!definition.frames[frameId]) continue;
      definition.frames[frameId].positionMm[1] = clearanceToolHeightMm;
      delete definition.frames[frameId].contactFixtureId;
    }
    contact.contactFixtureId = `${object.id}_pickup_adapter`;

    const pickupFixture = definition.fixtures.find((fixture) => fixture.id === `${object.id}_pickup_adapter`);
    const destinationFixture = definition.fixtures.find((fixture) => fixture.id === `${object.id}_destination_slot`);
    if (!pickupFixture || !destinationFixture) throw new Error(`${definition.id}/${object.id}: owning pickup or destination fixture is unavailable.`);
    const pickupSurfaceId = configureSurface(pickupFixture, object, contact, "pickup", objectRotation);
    const destinationSurfaceId = configureSurface(destinationFixture, object, definition.frames[placeId], "destination", objectRotation);
    object.physicalRest = physicalRest({
      definition,
      item: object,
      initialSurfaceId: pickupSurfaceId,
      finalSurfaceId: destinationSurfaceId,
      initialFrame: object.initialFrame,
      initialGripFrame: contactId,
      finalFrame: destinationId,
      finalGripFrame: placeId,
      gripSocketMm,
      initialRotation: objectRotation,
      finalRotation: objectRotation,
    });
    object.physicalRest.gripInterface = configuredGripInterface;
    object.physicalRest.geometry.provenance = `${object.visual.approximation} The collision envelope encloses the directly handled apparatus.`;

    const grasp = definition.grasps.find((item) => item.objectId === object.id);
    if (grasp) {
      grasp.mode = "direct-apparatus";
      grasp.interface = configuredGripInterface.replaceAll(" ", "_");
      grasp.fixtureId = pickupFixture.id;
      grasp.visible = true;
      grasp.allowedRobotContactBodies = [SO101_CONTACT_GEOMETRY.fixedWitness.bodyId, SO101_CONTACT_GEOMETRY.movingWitness.bodyId];
      grasp.physicalContact = {
        schema: "robobuddy.opposed-pinch.v1",
        axisLocal: [1, 0, 0],
        bandCenterLocalMm: [0, gripSocketMm[1], 0],
        bandHalfExtentsMm: [contactHalfExtentMm + 2, 26, Math.min(Number(halfExtentsMm[2]), 14)],
        contactHalfExtentMm,
        capturedThicknessMm: contactHalfExtentMm * 2,
        contactToleranceMm: SO101_CONTACT_GEOMETRY.contactToleranceMm,
        maxPenetrationMm: SO101_CONTACT_GEOMETRY.maximumFacePenetrationMm,
        alignmentToleranceDeg: SO101_CONTACT_GEOMETRY.alignmentToleranceDeg,
        fixedBodyId: SO101_CONTACT_GEOMETRY.fixedWitness.bodyId,
        movingBodyId: SO101_CONTACT_GEOMETRY.movingWitness.bodyId,
        fixedFaceSign: 1,
        movingFaceSign: -1,
        toolAxisTargetWorld: [...toolAxisTarget],
        negativeFaceRole: "moving",
        positiveFaceRole: "fixed",
        source: SO101_CONTACT_GEOMETRY.provenance,
      };
      grasp.approachFrame = approachId;
      grasp.contactFrame = contactId;
      grasp.liftFrame = liftId;
    }
  }

  if (SO101_TASK_TITLES[definition.id]) definition.title = SO101_TASK_TITLES[definition.id];
  rewriteUserFacingText(definition, SO101_USER_TEXT_REPLACEMENTS[definition.id] || []);
  normalizeObjectGoalLabels(definition);
  const directLabels = definition.objects.filter((item) => item.transportable !== false).map((item) => item.label);
  definition.brief = `Directly grasp, transfer, and stably place ${directLabels.join(" and ")} on the named real work-surface zones; no unmodeled laboratory operation or measurement is simulated.`;
  for (const process of definition.processModels || []) {
    if (typeof process.label === "string") process.label = process.label.replace(/carriers?/gi, "apparatus").replace(/destination slots?/gi, "receiving zones");
  }

  definition.fixtures = definition.fixtures.filter((fixture) => fixture.id !== "so101_base_mount");
  definition.fixtures.unshift({
    id: "so101_base_mount",
    label: "SO-101 fixed base mounting plate",
    visible: true,
    type: "so101_base_mount",
    configured: true,
    positionMm: [38.8, -7, 0],
    collisionProxy: {
      id: "so101-base-mount",
      type: "box",
      centerMm: [38.8, -7, 0],
      halfExtentsMm: [68, 7, 58],
      planningRole: "robot_mount_contact",
      provenance: "C: real fixed robot mounting plate; not an apparatus support",
    },
    description: "Configured opaque flush mounting plate aligned to the fixed-base root support plane. It supports the robot base only and is never used to prop task apparatus.",
  });

  assertScenarioV2(definition, { expectedRobotId: "so101_follower" });
  await writeFile(sourcePath, `${JSON.stringify(definition, null, 2)}\n`, "utf8");
  await writeFile(resolve(OUTPUT, name), `${JSON.stringify(stripValidationForClient(definition), null, 2)}\n`, "utf8");
}

console.log("Refined 10 owning SO-101 definitions: direct apparatus grips, broad work-surface rest, and no transport containers or synthetic posts/tabs.");
