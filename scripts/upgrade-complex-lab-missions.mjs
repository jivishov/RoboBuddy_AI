import fs from "node:fs";
import path from "node:path";
import { directApparatusVisual, physicalRest, IDENTITY_ROTATION, YAW_180_ROTATION } from "./portable-physical-rest-helpers.mjs";

const root = process.cwd();
const definitionsRoot = path.join(root, "missions", "lab-assistant", "v2", "definitions");

function read(relative) {
  return JSON.parse(fs.readFileSync(path.join(definitionsRoot, relative), "utf8"));
}

function write(relative, definition) {
  fs.writeFileSync(path.join(definitionsRoot, relative), `${JSON.stringify(definition, null, 2)}\n`);
}

function upsertById(items, item) {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) items[index] = item;
  else items.push(item);
}

function ruler(id, label, measurement) {
  return {
    id,
    type: "configured_measurement_ruler",
    label,
    visible: true,
    configured: true,
    presentationOnly: true,
    collisionAuthority: "none; visual measurement aid only",
    measurement: {
      units: "mm",
      minorTickMm: 10,
      majorTickMm: 50,
      labelEveryMm: 100,
      widthMm: 28,
      ...measurement,
    },
  };
}

function eventBefore(id, before, after, label) {
  return { id, label, op: "event_before", before, after };
}

function planarDistance(id, objectA, objectB, minMm, maxMm, label) {
  return { id, label, op: "object_planar_distance", objectA, objectB, plane: "xz", minMm, maxMm };
}

function planarOffset(id, objectId, originMm, minMm, maxMm, label) {
  return { id, label, op: "object_planar_offset", objectId, originMm, plane: "xz", minMm, maxMm };
}

function axisCoordinate(id, objectId, axis, originMm, minMm, maxMm, label) {
  return { id, label, op: "object_axis_coordinate", objectId, axis, originMm, minMm, maxMm };
}

function addConfiguredProvenance(definition, claim) {
  const existing = definition.provenance.find((entry) => entry.label === "C" && entry.claim.includes("ruler"));
  if (existing) existing.claim = claim;
  else definition.provenance.push({ label: "C", claim });
}

function configureHiddenRequirement(definition, processId, predicates, label, value) {
  const requirement = definition.hiddenGradingRequirements.find((item) => item.id === "completion_observation")
    || definition.hiddenGradingRequirements[0];
  requirement.label = label;
  requirement.allowedValues = [value];
  requirement.availableWhen = { op: "all", predicates };
  requirement.requiresEvent = { type: "PROCESS_COMMIT", processId };
  requirement.learnerCallable = false;
  requirement.authority = "plant/events";
}

function upgradeSo101QuantitativeTransfer() {
  const relative = "so101/so101-v2-06-quantitative-transfer.json";
  const definition = read(relative);
  definition.title = "Measured Two-Bottle Transfer Workcell";
  definition.brief = "Program an ordered, collision-checked SO-101 sequence that parks a capped stock bottle and capped rinse bottle at ruler-defined coordinates, verifies their final centre-to-centre spacing, releases each object on a real work surface, and retreats clear. No pouring, liquid motion, mass transfer, or force sensing is simulated.";
  definition.migration.legacyLearningObjective = "Program an ordered capped stock-and-rinse bottle staging sequence, use visible millimetre datums to verify the final layout, and distinguish physical robot handling from unsupported liquid transfer.";
  definition.migration.redesignRationale = "The single-arm SO-101 cannot safely reproduce a quantitative liquid transfer because fluid, payload, and force behavior are unsupported and cannot be validated by this model. The successor preserves the transfer-workcell reasoning as a measured two-object placement sequence with real collision-checked grasps, ordered release events, and ruler-verifiable geometry.";
  const [stock, rinse] = definition.objects;
  stock.label = "Capped stock-solution bottle";
  stock.visual.label = stock.label;
  rinse.label = "Capped rinse-water bottle";
  rinse.visual.label = rinse.label;
  upsertById(definition.fixtures, ruler("transfer_x_ruler", "Horizontal transfer-workcell ruler", {
    axis: "x", originMm: [-100, 3, 310], lengthMm: 500, direction: 1, startValueMm: -100,
  }));
  upsertById(definition.fixtures, ruler("transfer_z_ruler", "Depth ruler for destination verification", {
    axis: "z", originMm: [360, 3, 50], lengthMm: 300, direction: 1, startValueMm: 50,
  }));
  const ordered = eventBefore(
    "stock_release_before_rinse_pickup",
    { type: "DETACH_OBJECT", objectId: "aliquot_bottle", frameId: "aliquot_bottle_destination" },
    { type: "CONTACT", objectId: "capped_rinse_bottle", frameId: "capped_rinse_bottle_contact" },
    "The stock bottle must be released before the rinse-bottle pickup begins.",
  );
  const separation = planarDistance(
    "measured_bottle_spacing",
    "aliquot_bottle",
    "capped_rinse_bottle",
    348,
    374,
    "The final bottle centres must be 348–374 mm apart in the horizontal work plane.",
  );
  const stockCoordinate = axisCoordinate(
    "stock_x_coordinate",
    "aliquot_bottle",
    "x",
    [0, 0, 0],
    295,
    320,
    "The stock-bottle centre must align with the +295 to +320 mm ruler band.",
  );
  const rinseCoordinate = axisCoordinate(
    "rinse_x_coordinate",
    "capped_rinse_bottle",
    "x",
    [0, 0, 0],
    -46,
    -21,
    "The rinse-bottle centre must align with the −46 to −21 mm ruler band.",
  );
  definition.processModels[0].label = "Commit the measured transfer-workcell layout after the ordered second placement.";
  definition.processModels[0].prerequisites = [
    { op: "object_at", objectId: "aliquot_bottle", frameId: "aliquot_bottle_destination" },
    ordered,
    separation,
    stockCoordinate,
    rinseCoordinate,
  ];
  [ordered, separation, stockCoordinate, rinseCoordinate].forEach((goal) => upsertById(definition.goalPredicates, goal));
  configureHiddenRequirement(definition, "transfer_station_ready", [
    { op: "object_at", objectId: "aliquot_bottle", frameId: "aliquot_bottle_destination" },
    { op: "object_at", objectId: "capped_rinse_bottle", frameId: "capped_rinse_bottle_destination" },
    ordered,
    separation,
    stockCoordinate,
    rinseCoordinate,
    { op: "frame_visited", frameId: "aliquot_bottle_retreat" },
    { op: "frame_visited", frameId: "capped_rinse_bottle_retreat" },
    { op: "process_state", processId: "transfer_station_ready", value: "ready" },
  ], "Confirm the ruler-defined two-bottle layout, ordered release sequence, stable seating, and clear retreats.", "Measured two-bottle layout and ordered release confirmed from plant state.");
  definition.complexityUpgrade = {
    version: "2026-08-27",
    class: "measured_multi_object_sequence",
    preservedMotionGeometry: true,
    preservedPublicPythonActionFields: true,
    physicalHardwareValidated: false,
    unsupported: ["liquid transfer", "pouring", "mass measurement", "force sensing"],
  };
  addConfiguredProvenance(definition, "C: millimetre rulers, coordinate bands, and spacing tolerances are configured educational measurement datums. Grading reads authoritative plant object poses and event order; the rulers are visible non-colliding aids and do not replace IK, collision checking, stable-support validation, or the public SO-101 action interface.");
  write(relative, definition);
}

function upgradeSo101BuretteClearance() {
  const relative = "so101/so101-v2-08-burette-initial-reading.json";
  const definition = read(relative);
  definition.title = "Burette Receiver Clearance Calibration";
  definition.brief = "Program the SO-101 to park a capped titrant bottle outside the receiver exclusion zone, then place an empty beaker beneath a visible burette-centre datum within a 35 mm planar tolerance. The sequence uses the existing direct grasps, IK, collision checks, stable releases, and retreats; burette filling, dispensing, meniscus reading, and liquid behavior are not modeled.";
  definition.migration.legacyLearningObjective = "Program the ordered titrant-bottle and receiver setup, use visible horizontal and vertical millimetre datums to verify clearance, and distinguish setup geometry from a burette reading.";
  definition.migration.redesignRationale = "The validated SO-101 model can physically stage capped glassware, but burette filling, valve control, meniscus reading, and fluid metrology are unsupported and cannot be validated by this model. The successor converts the task into an instrument-clearance calibration with an ordered bottle parking step and a ruler-checked receiver-centering step.";
  definition.objects[0].label = "Capped titrant bottle";
  definition.objects[0].visual.label = definition.objects[0].label;
  definition.objects[1].label = "Empty titration receiver beaker";
  definition.objects[1].visual.label = definition.objects[1].label;
  upsertById(definition.fixtures, ruler("burette_vertical_ruler", "Vertical burette-centre height datum", {
    axis: "y", originMm: [-72, 0, 250], lengthMm: 300, direction: 1, startValueMm: 0, widthMm: 24,
  }));
  upsertById(definition.fixtures, ruler("burette_x_ruler", "Receiver-centering ruler", {
    axis: "x", originMm: [-100, 3, 300], lengthMm: 500, direction: 1, startValueMm: -100,
  }));
  const ordered = eventBefore(
    "titrant_parked_before_receiver_pickup",
    { type: "DETACH_OBJECT", objectId: "titrant_bottle", frameId: "titrant_bottle_destination" },
    { type: "CONTACT", objectId: "titration_beaker", frameId: "titration_beaker_contact" },
    "The capped titrant bottle must be parked before the receiver-beaker pickup begins.",
  );
  const receiverDatum = planarOffset(
    "receiver_centered_on_burette_datum",
    "titration_beaker",
    [0, 0, 250],
    0,
    35,
    "The beaker centre must finish within 35 mm of the configured burette centreline datum.",
  );
  const bottleClearance = planarOffset(
    "titrant_bottle_outside_receiver_zone",
    "titrant_bottle",
    [0, 0, 250],
    315,
    345,
    "The capped titrant bottle must remain 315–345 mm from the receiver centreline.",
  );
  const separation = planarDistance(
    "titration_workcell_spacing",
    "titrant_bottle",
    "titration_beaker",
    339,
    365,
    "The final bottle-to-beaker centre spacing must remain 339–365 mm.",
  );
  definition.processModels[0].label = "Commit the dry burette-receiver clearance layout after the ordered beaker placement.";
  definition.processModels[0].prerequisites = [
    { op: "object_at", objectId: "titrant_bottle", frameId: "titrant_bottle_destination" },
    ordered,
    receiverDatum,
    bottleClearance,
    separation,
  ];
  [ordered, receiverDatum, bottleClearance, separation].forEach((goal) => upsertById(definition.goalPredicates, goal));
  configureHiddenRequirement(definition, "burette_setup_ready", [
    { op: "object_at", objectId: "titrant_bottle", frameId: "titrant_bottle_destination" },
    { op: "object_at", objectId: "titration_beaker", frameId: "titration_beaker_destination" },
    ordered,
    receiverDatum,
    bottleClearance,
    separation,
    { op: "frame_visited", frameId: "titrant_bottle_retreat" },
    { op: "frame_visited", frameId: "titration_beaker_retreat" },
    { op: "process_state", processId: "burette_setup_ready", value: "ready" },
  ], "Confirm bottle-first ordering, receiver centering, exclusion-zone clearance, stable seating, and clear retreats.", "Dry burette-receiver clearance layout confirmed from plant state.");
  definition.complexityUpgrade = {
    version: "2026-08-27",
    class: "instrument_clearance_calibration",
    preservedMotionGeometry: true,
    preservedPublicPythonActionFields: true,
    physicalHardwareValidated: false,
    unsupported: ["burette filling", "stopcock actuation", "meniscus reading", "liquid dispensing"],
  };
  addConfiguredProvenance(definition, "C: the visible burette-centre and ruler datums, 35 mm receiver tolerance, bottle exclusion distance, and final spacing band are configured educational geometry. The plant grades live object poses and event order; no burette reading or fluid response is inferred.");
  write(relative, definition);
}

function upgradeSo101VacuumPreflight() {
  const relative = "so101/so101-v2-09-vacuum-filtration.json";
  const definition = read(relative);
  definition.title = "Vacuum Workcell Keep-Clear Preflight";
  definition.brief = "Program a dry, ordered SO-101 preflight: park the capped wash bottle on the supply side, then place the empty spill-control beaker on the receiver side while keeping the ruler-marked vacuum-hose corridor clear. Existing direct grasps, atomic action fields, IK, collision checks, stable support, release, and retreat behavior remain authoritative. Vacuum, hose coupling, filtration, pressure, and liquids are not simulated.";
  definition.migration.legacyLearningObjective = "Program an ordered vacuum-workcell preflight, preserve a ruler-defined hose corridor, and distinguish dry equipment staging from unsupported vacuum and filtration behavior.";
  definition.migration.redesignRationale = "A single SO-101 follower arm can safely stage dry sealed items, but vacuum-hose coupling, pressure integrity, slurry transfer, and liquid filtration are unsupported and cannot be validated by this model. The successor becomes a measured keep-clear preflight with ordered placement and corridor geometry that maps directly to real arm actions.";
  definition.objects[0].label = "Capped filtration wash bottle";
  definition.objects[0].visual.label = definition.objects[0].label;
  definition.objects[1].label = "Empty spill-control beaker";
  definition.objects[1].visual.label = definition.objects[1].label;
  upsertById(definition.fixtures, ruler("vacuum_corridor_left_ruler", "Vacuum-hose corridor left datum", {
    axis: "z", originMm: [125, 3, 70], lengthMm: 260, direction: 1, startValueMm: 70, widthMm: 20,
  }));
  upsertById(definition.fixtures, ruler("vacuum_corridor_right_ruler", "Vacuum-hose corridor right datum", {
    axis: "z", originMm: [155, 3, 70], lengthMm: 260, direction: 1, startValueMm: 70, widthMm: 20,
  }));
  const ordered = eventBefore(
    "wash_bottle_release_before_beaker_pickup",
    { type: "DETACH_OBJECT", objectId: "filtration_reagent_bottle", frameId: "filtration_reagent_bottle_destination" },
    { type: "CONTACT", objectId: "filtration_beaker", frameId: "filtration_beaker_contact" },
    "The capped wash bottle must be released before the beaker pickup begins.",
  );
  const bottleSide = axisCoordinate(
    "wash_bottle_supply_side",
    "filtration_reagent_bottle",
    "x",
    [140, 0, 0],
    150,
    180,
    "The wash-bottle centre must remain 150–180 mm on the supply side of the hose-corridor centreline.",
  );
  const beakerSide = axisCoordinate(
    "beaker_receiver_side",
    "filtration_beaker",
    "x",
    [140, 0, 0],
    -176,
    -150,
    "The beaker centre must remain 150–176 mm on the receiver side of the hose-corridor centreline.",
  );
  const separation = planarDistance(
    "vacuum_preflight_spacing",
    "filtration_reagent_bottle",
    "filtration_beaker",
    339,
    365,
    "The final dry-preflight objects must remain 339–365 mm apart in the work plane.",
  );
  definition.processModels[0].label = "Commit the dry vacuum-workcell preflight only after the hose corridor remains clear.";
  definition.processModels[0].prerequisites = [
    { op: "object_at", objectId: "filtration_reagent_bottle", frameId: "filtration_reagent_bottle_destination" },
    ordered,
    bottleSide,
    beakerSide,
    separation,
  ];
  [ordered, bottleSide, beakerSide, separation].forEach((goal) => upsertById(definition.goalPredicates, goal));
  for (const goal of definition.goalPredicates) {
    if (goal.frameId?.startsWith("filtration_reagent_bottle")) goal.label = goal.label?.replace(/Sealed empty filter flask apparatus/g, "capped filtration wash bottle");
    if (goal.frameId?.startsWith("filtration_beaker")) goal.label = goal.label?.replace(/Sealed capped rinse bottle apparatus/g, "empty spill-control beaker");
  }
  configureHiddenRequirement(definition, "filtration_station_ready", [
    { op: "object_at", objectId: "filtration_reagent_bottle", frameId: "filtration_reagent_bottle_destination" },
    { op: "object_at", objectId: "filtration_beaker", frameId: "filtration_beaker_destination" },
    ordered,
    bottleSide,
    beakerSide,
    separation,
    { op: "frame_visited", frameId: "filtration_reagent_bottle_retreat" },
    { op: "frame_visited", frameId: "filtration_beaker_retreat" },
    { op: "process_state", processId: "filtration_station_ready", value: "ready" },
  ], "Confirm the supply/receiver-side coordinates, clear hose corridor, bottle-first order, stable seating, and clear retreats.", "Dry vacuum-workcell keep-clear preflight confirmed from plant state.");
  definition.complexityUpgrade = {
    version: "2026-08-27",
    class: "measured_keep_clear_preflight",
    preservedMotionGeometry: true,
    preservedPublicPythonActionFields: true,
    physicalHardwareValidated: false,
    unsupported: ["vacuum pressure", "hose coupling", "filtration", "fluid transfer"],
  };
  addConfiguredProvenance(definition, "C: the two visible corridor rulers, ±150 mm side-clearance bands, and object-spacing tolerance are configured educational geometry. They grade authoritative object poses and event order while remaining non-colliding presentation aids; vacuum pressure, hose attachment, and liquid filtration remain explicitly unsupported.");
  write(relative, definition);
}


function upgradeOpenArmSupportedStacks() {
  const relative = "openarm/openarm-04-filtration-workcell.json";
  const definition = read(relative);
  definition.title = "Bimanual Heater and Ring-Stand Stack";
  definition.brief = "Program the OpenArm bimanual robot to place an empty Erlenmeyer flask on a visible unpowered hotplate and an empty beaker on a visible ring-stand wire-gauze support. Each arm uses direct apparatus contact, collision-checked IK, stable support validation, release, and retreat. Heating, temperature, liquids, payload capacity, and force control are not simulated or claimed.";
  definition.migration.legacyLearningObjective = "Program a bimanual laboratory-equipment setup that places empty glassware onto two real, visible support stacks while preserving direct handling, collision clearance, stable seating, and sequential shared-state coordination.";
  definition.migration.redesignRationale = "The original filtration arrangement did not exploit OpenArm's bimanual reach and would require unsupported vacuum and fluid behavior for a realistic filtration operation. The successor uses two physically explicit dry apparatus stacks: an unpowered hotplate supporting an empty Erlenmeyer flask and a ring stand with wire gauze supporting an empty beaker.";

  Object.assign(definition.frames.left_approach, { positionMm: [310, 596, -340] });
  Object.assign(definition.frames.left_contact, { positionMm: [310, 416, -340] });
  Object.assign(definition.frames.left_lift, { positionMm: [310, 536, -340] });
  Object.assign(definition.frames.left_handoff, { positionMm: [440, 536, -340] });
  Object.assign(definition.frames.left_place_contact, { positionMm: [440, 438, -340] });
  Object.assign(definition.frames.left_retreat, { positionMm: [440, 561, -340] });
  Object.assign(definition.frames.right_approach, { positionMm: [310, 543, 340] });
  Object.assign(definition.frames.right_contact, { positionMm: [310, 363, 340] });
  Object.assign(definition.frames.right_lift, { positionMm: [310, 483, 340] });
  Object.assign(definition.frames.right_handoff, { positionMm: [440, 483, 340] });
  Object.assign(definition.frames.right_place_contact, { positionMm: [440, 431, 340] });
  Object.assign(definition.frames.right_retreat, { positionMm: [440, 508, 340] });

  const tableFixture = definition.fixtures.find((fixture) => fixture.type === "configured_visible_bimanual_workcell");
  tableFixture.id = "supported_stack_workcell";
  tableFixture.label = "Visible dual-table bimanual workcell for supported dry apparatus stacking";
  tableFixture.claimBoundary = "The two visible floor-anchored worktops support a real unpowered hotplate and a real ring-stand/gauze assembly. The robot directly grasps the empty vessels and releases them only onto the declared visible support surfaces. No tray, carrier, registration pin, hidden support, heating, force, payload, fluid, or hardware-safety behavior is inferred.";

  const heaterFixture = {
    id: "left_unpowered_hotplate",
    type: "configured_heater_platform",
    label: "Visible unpowered hotplate with ceramic top",
    visible: true,
    powered: false,
    thermalModel: "not modeled",
    sourceBackedHolder: true,
    collisionProxies: [
      {
        id: "left-heater-body",
        type: "box",
        centerMm: [440, 330, -340],
        halfExtentsMm: [66, 10, 62],
        provenance: "C: conservative visible benchtop hotplate body envelope, 132 x 20 x 124 mm, resting on the real worktop",
      },
      {
        id: "left-heater-top",
        type: "box",
        centerMm: [440, 341, -340],
        halfExtentsMm: [58, 1, 54],
        planningRole: "contact_support",
        physicalSupportSurface: true,
        sourceBackedHolder: true,
        provenance: "C: visible 116 x 108 mm ceramic hotplate top; configured support top is y=342 mm",
      },
      {
        id: "left-heater-control-face",
        type: "box",
        centerMm: [440, 328, -399],
        halfExtentsMm: [64, 5, 3],
        provenance: "C: visible front control-face envelope; controls are decorative and the heater remains unpowered",
      },
    ],
  };
  const ringStandFixture = {
    id: "right_ring_stand_gauze",
    type: "configured_ring_stand_support",
    label: "Visible ring stand with clamp and wire-gauze support",
    visible: true,
    sourceBackedHolder: true,
    collisionProxies: [
      {
        id: "right-ring-stand-base",
        type: "box",
        centerMm: [500, 328, 475],
        halfExtentsMm: [65, 8, 75],
        provenance: "C: visible 130 x 16 x 150 mm floor plate resting on the right worktop behind the receiver lane",
      },
      {
        id: "right-ring-stand-rod",
        type: "box",
        centerMm: [545, 426, 500],
        halfExtentsMm: [5, 90, 5],
        provenance: "C: conservative square proxy around the visible 10 mm support rod",
      },
      {
        id: "right-ring-clamp-x-arm",
        type: "box",
        centerMm: [492.5, 375, 500],
        halfExtentsMm: [52.5, 4, 4],
        provenance: "C: visible horizontal clamp arm extending from the stand rod toward the receiver axis",
      },
      {
        id: "right-ring-clamp-z-arm",
        type: "box",
        centerMm: [440, 375, 420],
        halfExtentsMm: [4, 4, 80],
        provenance: "C: visible clamp extension reaching the wire-gauze support while remaining below the vessel base",
      },
      {
        id: "right-gauze-top",
        type: "box",
        centerMm: [440, 387, 340],
        halfExtentsMm: [48, 1, 48],
        planningRole: "contact_support",
        physicalSupportSurface: true,
        sourceBackedHolder: true,
        provenance: "C: visible 96 x 96 mm wire-gauze support on a clamped ring; configured support top is y=388 mm",
      },
    ],
  };
  definition.fixtures = [tableFixture, heaterFixture, ringStandFixture];
  upsertById(definition.fixtures, ruler("left_stack_height_ruler", "Hotplate stack height ruler", {
    axis: "y", originMm: [520, 320, -340], lengthMm: 180, direction: 1, startValueMm: 320, widthMm: 22,
  }));
  upsertById(definition.fixtures, ruler("right_stack_height_ruler", "Ring-stand stack height ruler", {
    axis: "y", originMm: [360, 320, 340], lengthMm: 180, direction: 1, startValueMm: 320, widthMm: 22,
  }));

  const leftItem = {
    id: "left_erlenmeyer",
    label: "Empty Erlenmeyer flask",
    configuredApparatusProfile: "flask",
    initialFrame: "left_contact",
    visible: true,
    transportable: true,
    allowedEffectors: ["left"],
    initialState: { contentsSimulation: "empty; no liquid modeled" },
    attachmentInterface: "direct_apparatus_grip",
  };
  leftItem.visual = directApparatusVisual(leftItem);
  leftItem.physicalRest = physicalRest({
    definition,
    item: leftItem,
    initialSurfaceId: "left-worktop",
    finalSurfaceId: "left-heater-top",
    initialFrame: "left_contact",
    initialGripFrame: "left_contact",
    finalFrame: "left_handoff",
    finalGripFrame: "left_place_contact",
    initialRotation: IDENTITY_ROTATION,
    finalRotation: IDENTITY_ROTATION,
  });
  leftItem.configuredGripInterface = `${leftItem.physicalRest.gripInterface}; direct contact with the empty flask, with no tray, carrier, cassette, bin, or proxy payload.`;
  leftItem.roleRedesign = "The left arm directly pinches the empty Erlenmeyer neck and seats the flask on the visible unpowered hotplate top.";

  const rightItem = {
    id: "right_beaker",
    label: "Empty 50 mL beaker",
    configuredApparatusProfile: "small_beaker",
    initialFrame: "right_contact",
    visible: true,
    transportable: true,
    allowedEffectors: ["right"],
    initialState: { contentsSimulation: "empty; no liquid modeled" },
    attachmentInterface: "direct_apparatus_grip",
  };
  rightItem.visual = directApparatusVisual(rightItem);
  rightItem.physicalRest = physicalRest({
    definition,
    item: rightItem,
    initialSurfaceId: "right-worktop",
    finalSurfaceId: "right-gauze-top",
    initialFrame: "right_contact",
    initialGripFrame: "right_contact",
    finalFrame: "right_handoff",
    finalGripFrame: "right_place_contact",
    initialRotation: YAW_180_ROTATION,
    finalRotation: YAW_180_ROTATION,
  });
  rightItem.configuredGripInterface = `${rightItem.physicalRest.gripInterface}; direct contact with the empty beaker rim wall, with no tray, carrier, cassette, bin, or proxy payload.`;
  rightItem.roleRedesign = "The right arm directly pinches the empty beaker rim wall and seats the beaker on the visible wire-gauze support.";
  definition.objects = [leftItem, rightItem];

  definition.grasps = [
    {
      id: "left_erlenmeyer_left_grasp",
      objectId: "left_erlenmeyer",
      effector: "left",
      chainId: "left",
      mode: "direct-apparatus",
      approachFrame: "left_approach",
      contactFrame: "left_contact",
      liftFrame: "left_lift",
      destinationFrame: "left_handoff",
      placeFrame: "left_place_contact",
      retreatFrame: "left_retreat",
      visible: true,
      attachmentInterface: "direct_apparatus_grip",
      contactInterface: leftItem.physicalRest.gripInterface,
      allowedRobotContactBodies: ["left_finger_inner", "left_finger_outer"],
    },
    {
      id: "right_beaker_right_grasp",
      objectId: "right_beaker",
      effector: "right",
      chainId: "right",
      mode: "direct-apparatus",
      approachFrame: "right_approach",
      contactFrame: "right_contact",
      liftFrame: "right_lift",
      destinationFrame: "right_handoff",
      placeFrame: "right_place_contact",
      retreatFrame: "right_retreat",
      visible: true,
      attachmentInterface: "direct_apparatus_grip",
      contactInterface: rightItem.physicalRest.gripInterface,
      allowedRobotContactBodies: ["right_finger_inner", "right_finger_outer"],
    },
  ];

  const leftHeight = axisCoordinate(
    "erlenmeyer_hotplate_height",
    "left_erlenmeyer",
    "y",
    [0, 320, 0],
    20,
    24,
    "The Erlenmeyer base must finish 20–24 mm above the worktop on the hotplate support.",
  );
  const rightHeight = axisCoordinate(
    "beaker_ring_stand_height",
    "right_beaker",
    "y",
    [0, 320, 0],
    66,
    70,
    "The beaker base must finish 66–70 mm above the worktop on the wire-gauze support.",
  );
  const leftReleaseBeforeRetreat = eventBefore(
    "left_release_before_clear_retreat",
    { type: "DETACH_OBJECT", objectId: "left_erlenmeyer", frameId: "left_handoff" },
    { type: "FRAME_REACHED", frameId: "left_retreat", effector: "left" },
    "The left gripper must release the flask on the hotplate before moving to the raised retreat frame.",
  );
  const rightReleaseBeforeRetreat = eventBefore(
    "right_release_before_clear_retreat",
    { type: "DETACH_OBJECT", objectId: "right_beaker", frameId: "right_handoff" },
    { type: "FRAME_REACHED", frameId: "right_retreat", effector: "right" },
    "The right gripper must release the beaker on the wire gauze before moving to the raised retreat frame.",
  );
  const eventRequirements = [
    { op: "object_at", objectId: "left_erlenmeyer", frameId: "left_handoff" },
    { op: "object_at", objectId: "right_beaker", frameId: "right_handoff" },
    { op: "event", match: { type: "CONTACT", objectId: "left_erlenmeyer", frameId: "left_contact" } },
    { op: "event", match: { type: "ATTACH_OBJECT", objectId: "left_erlenmeyer", effector: "left" } },
    { op: "event", match: { type: "PLACE_CONTACT", objectId: "left_erlenmeyer", frameId: "left_place_contact" } },
    { op: "event", match: { type: "DETACH_OBJECT", objectId: "left_erlenmeyer", frameId: "left_handoff" } },
    { op: "event", match: { type: "CONTACT", objectId: "right_beaker", frameId: "right_contact" } },
    { op: "event", match: { type: "ATTACH_OBJECT", objectId: "right_beaker", effector: "right" } },
    { op: "event", match: { type: "PLACE_CONTACT", objectId: "right_beaker", frameId: "right_place_contact" } },
    { op: "event", match: { type: "DETACH_OBJECT", objectId: "right_beaker", frameId: "right_handoff" } },
    leftReleaseBeforeRetreat,
    rightReleaseBeforeRetreat,
    leftHeight,
    rightHeight,
  ];
  definition.processModels = [{
    id: "supported_stack_confirmed",
    label: "Confirm both empty vessels are stably seated on their visible equipment supports.",
    discrete: true,
    contactGated: true,
    initialState: "ready",
    completeState: "confirmed",
    fixtureId: "supported_stack_workcell",
    prerequisites: eventRequirements,
    unsupportedContinuity: "No continuous material, payload, force, fluid, thermal, electrical, or instrument-response model is implied.",
    contactFrame: "left_handoff",
  }];
  definition.goalPredicates = [
    { id: "left_stack_complete", label: "Empty Erlenmeyer visibly seated on the unpowered hotplate", op: "object_at", objectId: "left_erlenmeyer", frameId: "left_handoff" },
    { id: "right_stack_complete", label: "Empty beaker visibly seated on the ring-stand wire gauze", op: "object_at", objectId: "right_beaker", frameId: "right_handoff" },
    leftHeight,
    rightHeight,
    { id: "workcell_confirmation_complete", op: "process_state", processId: "supported_stack_confirmed", value: "confirmed" },
    leftReleaseBeforeRetreat,
    rightReleaseBeforeRetreat,
  ];
  definition.prohibitedStates = [
    { id: "fixed_base_moved", op: "truthy", path: "fixedRootViolation" },
    {
      id: "object_remains_attached",
      op: "any",
      predicates: [
        { op: "truthy", path: "objects.left_erlenmeyer.attachedTo" },
        { op: "truthy", path: "objects.right_beaker.attachedTo" },
      ],
    },
    {
      id: "morphology_invalid_cross_arm_contact",
      op: "any",
      predicates: [
        { op: "event", match: { type: "CONTACT", objectId: "left_erlenmeyer", frameId: "right_contact" } },
        { op: "event", match: { type: "ATTACH_OBJECT", objectId: "left_erlenmeyer", effector: "right" } },
        { op: "event", match: { type: "PLACE_CONTACT", objectId: "left_erlenmeyer", frameId: "right_place_contact" } },
        { op: "event", match: { type: "CONTACT", objectId: "right_beaker", frameId: "left_contact" } },
        { op: "event", match: { type: "ATTACH_OBJECT", objectId: "right_beaker", effector: "left" } },
        { op: "event", match: { type: "PLACE_CONTACT", objectId: "right_beaker", frameId: "left_place_contact" } },
      ],
    },
  ];
  definition.hiddenGradingRequirements = [{
    id: "observable_confirmation",
    kind: "learner-recorded",
    prompt: "After both visible support contacts, record the two object ids, their destination frames, and the measured base heights above the 320 mm worktop datum.",
    minLength: 56,
    valuePattern: "^(?=.*left_erlenmeyer)(?=.*left_handoff)(?=.*right_beaker)(?=.*right_handoff)(?=.*22)(?=.*68).{56,}$",
    availableWhen: { op: "process_state", processId: "supported_stack_confirmed", value: "confirmed" },
    requiresEvent: { type: "PROCESS_COMMIT", processId: "supported_stack_confirmed", value: "confirmed" },
    learnerCallable: false,
    authority: "plant/events",
  }];

  definition.coordination.layoutTemplateId = "openarm-supported-dual-stack-v1";
  definition.coordination.claimBoundary = "Each arm is scheduled sequentially from the live shared-joint state against the two visible worktops, unpowered hotplate, and ring-stand proxies. Stable support and inter-effector separation are validated in the kinematic plant; payload, force, thermal, electrical, and hardware collision-recovery performance are not claimed.";
  definition.coordination.presentation.supportFoundation = "floor_anchored_tables_with_visible_hotplate_and_ring_stand";
  definition.coordination.presentation.stackSupportTopsMm = { hotplate: 342, ringStandGauze: 388 };
  definition.coordination.tableClearance.transitToolCenterY = 536;
  definition.coordination.tableClearance.transitToolCenterYBySide = { left: 536, right: 483 };
  definition.coordination.tableClearance.contactToolCenterY = { left: 416, right: 363 };
  definition.coordination.tableClearance.stagingApparatus = "empty Erlenmeyer flask and empty 50 mL beaker grasped directly at declared sockets; final support is provided by the visible unpowered hotplate top and visible wire-gauze ring-stand surface";
  definition.coordination.tableClearance.forbiddenReachabilityAids = ["transport trays", "proxy carriers", "registration pins", "synthetic reachability rods", "hidden supports", "tilted resting payloads"];
  definition.coordination.tableClearance.basis = "Both empty vessels remain upright and world-up. Their complete footprints are supported by real visible equipment surfaces above the worktops; each gripper opens only at the declared support-contact pose, then rises to a distinct 25 mm higher retreat frame before the process can commit.";

  definition.validation.referenceExecutions[0].description = "Validation-only left-stack then right-stack transport with direct apparatus contact, support-height checks, and post-event confirmation.";
  definition.validation.acceptedAlternates[0].description = "Causally safe reversed arm order with different deterministic IK seeds; both support stacks remain independent and visible.";
  definition.validation.negativeCases = definition.validation.negativeCases.map((item) => ({
    ...item,
    description: item.id === "negative-cross-arm-effector"
      ? "The left-lane Erlenmeyer is deliberately assigned to the right effector and must be rejected before contact or mutation."
      : item.id === "negative-process-before-placement"
        ? "The contact-gated stack confirmation is attempted before both vessels are stably seated and both retreats are observed."
        : item.description,
  }));
  definition.complexityUpgrade = {
    version: "2026-08-27",
    class: "bimanual_supported_equipment_stack",
    preservedPublicPythonActionFields: true,
    physicalHardwareValidated: false,
    supportHeightsMm: { hotplateTop: 342, ringStandGauzeTop: 388 },
    unsupported: ["heater power", "temperature", "liquid behavior", "payload capacity", "force control"],
  };
  definition.provenance = definition.provenance.filter((entry) => entry.label !== "F" || !entry.claim.includes("filtration"));
  definition.provenance.push({
    label: "F",
    claim: "The successor preserves the bounded bimanual laboratory-apparatus setup objective from openarm-04-filtration-workcell while replacing unsupported filtration behavior with dry, visible support-stack assembly.",
    sourceRef: "missions/lab-assistant/v1/openarm-04-filtration-workcell.json",
  });
  addConfiguredProvenance(definition, "C: the unpowered hotplate, ceramic support top, ring-stand base/rod/clamp, wire-gauze support, vertical millimetre rulers, and 22/68 mm support-height bands are configured educational geometry. All solid equipment parts remain visible and collision checked; the rulers are non-colliding aids. No thermal, payload, force, electrical, or fluid response is inferred.");
  definition.portablePython.referenceActions = [];
  definition.validation.referenceExecutions[0].calls = [
    {
      method: "skills.transport",
      args: {
        objectId: "left_erlenmeyer",
        effector: "left",
        approachFrame: "left_approach",
        contactFrame: "left_contact",
        liftFrame: "left_lift",
        destinationFrame: "left_handoff",
        placeFrame: "left_place_contact",
        retreatFrame: "left_retreat",
      },
    },
    {
      method: "skills.transport",
      args: {
        objectId: "right_beaker",
        effector: "right",
        approachFrame: "right_approach",
        contactFrame: "right_contact",
        liftFrame: "right_lift",
        destinationFrame: "right_handoff",
        placeFrame: "right_place_contact",
        retreatFrame: "right_retreat",
      },
    },
  ];
  write(relative, definition);
}

upgradeSo101QuantitativeTransfer();
upgradeSo101BuretteClearance();
upgradeSo101VacuumPreflight();
upgradeOpenArmSupportedStacks();

console.log("Upgraded SO-101 missions 06/08/09 and OpenArm mission 04 with measured, physically supported complex tasks.");
