import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROBOTS, SOURCE_ACTIONS, SOURCE_TITLES, TASKS } from "./lab-scenario-specs.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = resolve(REPO_ROOT, "missions", "lab-assistant");

const ZONE_POSITIONS = Object.freeze({
  home: [0, 0, 0], dock: [0, 0, 0], safety: [0, 0, -260], supply_zone: [-260, 0, 100],
  storage_zone: [-380, 0, -80], work_zone: [-120, 0, -260], balance_zone: [280, 0, 120],
  measuring_zone: [180, 0, -120], mixing_zone: [300, 0, -120], cuvette_rack_zone: [-260, 0, -100],
  instrument_zone: [360, 0, 0], filtration_zone: [260, 0, 250], stand_zone: [180, 0, 260],
  burette_zone: [80, 0, 300], burette_receiver_zone: [80, 0, 220], chromatography_zone: [-160, 0, 280],
  cooling_zone: [-320, 0, 250], oven_zone: [-420, 0, 180], wash_zone: [420, 0, 240],
  waste_zone: [460, 0, -220], transfer_zone: [160, 0, -260], stock_zone: [-420, 0, -200],
  preparation_zone: [80, 0, -300], extraction_zone: [-60, 0, 300]
});

const COMMAND_NAMES = Object.freeze({
  g: "grasp", p: "place", i: "insert_into", t: "pour_into", o: "operate",
  r: "read_instrument", n: "record_observation", k: "pick_nearest", x: "release_object", h: "home"
});

const VISUAL_REFERENCES = Object.freeze({
  balance: "analytical-balance.png", watch_glass: "watch-glass.png", weigh_boat: "weigh-boat.png",
  beaker: "beaker-250ml.png", cylinder: "graduated-cylinder-100ml.png", flask: "erlenmeyer-flask-250ml.png",
  stopper: "volumetric-flask-stoppered.png", filter_flask: "side-arm-filter-flask.png", cuvette: "cuvette.png",
  rack: "sample-rack.png", instrument: "spectrophotometer.png", filter_paper: "filter-paper.png",
  funnel: "funnel.png", buchner_funnel: "buchner-funnel.png", burette: "ring-stand-burette.png",
  stand: "ring-stand.png", bottle: "reagent-bottle.png", pipette: "volumetric-pipette-10ml.png",
  pipette_pump: "pipette-pump.png", oven: "drying-oven.png", cooling_rack: "wire-gauze.png",
  chromatography_paper: "chromatography-paper.png", chromatography_chamber: "chromatography-chamber-with-paper.png",
  separatory_funnel: "separatory-funnel.png", vacuum_source: "vacuum-source.png", wash_station: "wash-bottle.png",
  queue_station: "sample-rack.png", secured_carrier: "reagent-tray.png", tool: "capillary-spotter.png"
});

const HOME_JOINTS = Object.freeze({
  arduino_arm: { base: 90, shoulder: 90, elbow: 90, wrist_rot: 90, wrist_tilt: 90, gripper: 90 },
  so101_follower: { shoulder_pan: 0, shoulder_lift: -90, elbow_flex: 85, wrist_flex: 72, wrist_roll: 88, gripper: 85 },
  lekiwi_sim: { shoulder_pan: 0, shoulder_lift: 0, elbow_flex: 0, wrist_flex: 0, wrist_roll: 0, gripper: 50 },
  openarm_v2_bimanual: {
    base_yaw: 0,
    left_j1: -25, left_j2: -35, left_j3: 0, left_j4: 75, left_j5: 0, left_j6: -5, left_j7: 0, left_gripper: 12,
    right_j1: 25, right_j2: 35, right_j3: 0, right_j4: 75, right_j5: 0, right_j6: 5, right_j7: 0, right_gripper: 12
  },
  unitree_g1_29dof: {
    left_hip_pitch_joint: 0, left_hip_roll_joint: 0, left_hip_yaw_joint: 0, left_knee_joint: 0, left_ankle_pitch_joint: 0, left_ankle_roll_joint: 0,
    right_hip_pitch_joint: 0, right_hip_roll_joint: 0, right_hip_yaw_joint: 0, right_knee_joint: 0, right_ankle_pitch_joint: 0, right_ankle_roll_joint: 0,
    waist_yaw_joint: 0, waist_roll_joint: 0, waist_pitch_joint: 0,
    left_shoulder_pitch_joint: 0, left_shoulder_roll_joint: 0, left_shoulder_yaw_joint: 0, left_elbow_joint: 0, left_wrist_roll_joint: 0, left_wrist_pitch_joint: 0, left_wrist_yaw_joint: 0,
    right_shoulder_pitch_joint: 0, right_shoulder_roll_joint: 0, right_shoulder_yaw_joint: 0, right_elbow_joint: 0, right_wrist_roll_joint: 0, right_wrist_pitch_joint: 0, right_wrist_yaw_joint: 0
  }
});

function parseWorkflowLine(line) {
  const [code, ...tokens] = String(line).trim().split(/\s+/);
  const type = COMMAND_NAMES[code];
  if (!type) throw new Error(`Unknown workflow command ${code} in ${line}`);
  if (type === "home") return { type };
  if (type === "grasp") return compact({ type, objectId: tokens[0], at: tokens[1], effector: tokens[2] });
  if (type === "place") return compact({ type, objectId: tokens[0], zoneId: tokens[1], effector: tokens[2] });
  if (type === "insert_into" || type === "pour_into") {
    return compact({ type, objectId: tokens[0], targetId: tokens[1], at: tokens[2], effector: tokens[3] });
  }
  if (type === "operate") {
    return compact({
      type, controlId: tokens[0], mode: tokens[1], at: tokens[2],
      value: tokens[3] === "none" ? undefined : tokens[3],
      effector: tokens[4]
    });
  }
  if (type === "read_instrument") return { type, instrumentId: tokens[0], at: tokens[1] };
  if (type === "record_observation") return { type, fieldId: tokens[0], value: tokens.slice(1).join(" ") };
  if (type === "pick_nearest") return { type, objectId: tokens[0], at: tokens[1], hand: tokens[2] };
  if (type === "release_object") return { type, objectId: tokens[0], zoneId: tokens[1], hand: tokens[2] };
  throw new Error(`Unsupported workflow command ${type}`);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function assistanceFor(rank) {
  return rank <= 3 ? "Guided" : rank <= 7 ? "Builder" : "Challenge";
}

function complexityFor(rank) {
  return rank <= 3 ? "Foundational" : rank <= 7 ? "Intermediate" : "Advanced";
}

function labelFromId(id) {
  return String(id || "").split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function typeFromId(id) {
  const value = id.toLowerCase();
  if (value === "burette_stopcock" || value === "separatory_funnel_stopcock") return "control";
  if (value === "flask_stopper") return "stopper";
  if (value === "pipette_pump") return "pipette_pump";
  if (value === "vacuum_connection") return "control";
  if (value === "wash_station") return "wash_station";
  if (value === "instrument_queue") return "queue_station";
  if (value === "chromatography_chamber") return "chromatography_chamber";
  if (value === "endpoint_indicator") return "control";
  if (value === "aliquot_carrier") return "bottle";
  if (value.includes("balance")) return "balance";
  if (value.includes("watch_glass")) return "watch_glass";
  if (value.includes("weigh_boat")) return "weigh_boat";
  if (value.includes("burette")) return "burette";
  if (value.includes("separatory_funnel")) return "separatory_funnel";
  if (value.includes("buchner_funnel")) return "buchner_funnel";
  if (value.includes("funnel")) return "funnel";
  if (value.includes("filter_flask")) return "filter_flask";
  if (value.includes("flask")) return "flask";
  if (value.includes("cuvette") && value.includes("rack")) return "rack";
  if (value.includes("cuvette")) return "cuvette";
  if (value.includes("spectro") || value.includes("instrument") || value.includes("indicator")) return "instrument";
  if (value.includes("chromatography_paper")) return "chromatography_paper";
  if (value.includes("filter_paper")) return "filter_paper";
  if (value.includes("pipette")) return "pipette";
  if (value.includes("tray") || value.includes("carrier") || value.includes("tote") || value.includes("bin")) return "secured_carrier";
  if (value.includes("bottle")) return "bottle";
  if (value.includes("beaker")) return "beaker";
  if (value.includes("oven")) return "oven";
  if (value.includes("cooling")) return "cooling_rack";
  if (value.includes("stand")) return "stand";
  if (value.includes("capillary") || value.includes("spatula")) return "tool";
  if (value.includes("rack")) return "secured_carrier";
  if (value.includes("cylinder")) return "cylinder";
  return "apparatus";
}

function visualVariantFor(id, type, compatibleTargets = []) {
  const value = String(id || "").toLowerCase();
  if (type === "filter_paper") return compatibleTargets.includes("buchner_funnel") ? "buchner_disc" : "gravity_cone";
  if (type === "secured_carrier") {
    if (value.includes("rack")) return "rack";
    if (value.includes("bin")) return "bin";
    if (value.includes("tote")) return "tote";
    if (value.includes("tray")) return "tray";
    return "carrier";
  }
  if (type === "rack" || type === "queue_station") return "rack";
  if (type === "flask") return value.includes("volumetric") ? "volumetric_flask" : "erlenmeyer";
  if (type === "bottle") return value.includes("wash") ? "wash_bottle" : "reagent_bottle";
  if (type === "tool") return value.includes("spatula") ? "scoop" : "capillary";
  return "default";
}

function visualReferenceFor(id, type, visualVariant = "default") {
  if (id === "burette_stopcock") return "ring-stand-burette.png";
  if (id === "separatory_funnel_stopcock") return "separatory-funnel.png";
  if (id === "vacuum_connection") return "side-arm-filter-flask.png";
  if (id === "endpoint_indicator") return "erlenmeyer-flask-250ml.png";
  if (type === "filter_paper") return visualVariant === "gravity_cone" ? "funnel-filter-paper.png" : "filter-paper.png";
  if (type === "secured_carrier" && visualVariant === "rack") return "sample-rack.png";
  if (type === "flask" && visualVariant === "volumetric_flask") return "volumetric-flask.png";
  if (type === "bottle" && visualVariant === "wash_bottle") return "wash-bottle.png";
  if (type === "tool" && visualVariant === "scoop") return "lab-scoop.png";
  return VISUAL_REFERENCES[type] || "unmatched-approximation";
}

function sceneCompanions(task, objectIds, operations) {
  const companions = [];
  const companionIds = new Set();
  const aliases = new Map();
  const add = (id, initialZone, type) => {
    if (!objectIds.has(id) && !companionIds.has(id)) {
      companions.push({ id, initialZone, type });
      companionIds.add(id);
    }
  };
  const hasType = (type) => [...objectIds].some((id) => typeFromId(id) === type) || companions.some((item) => item.type === type);
  const visitedZones = new Set(operations.flatMap((operation) => [operation.at, operation.zoneId]).filter(Boolean));
  if (objectIds.has("burette_stopcock")) {
    add("burette", "burette_zone", "burette");
    aliases.set("burette_stopcock", "burette");
  }
  if (objectIds.has("endpoint_indicator")) {
    add("erlenmeyer_flask", "burette_receiver_zone", "flask");
    aliases.set("endpoint_indicator", "erlenmeyer_flask");
  }
  if (objectIds.has("separatory_funnel_stopcock")) aliases.set("separatory_funnel_stopcock", "separatory_funnel");
  if (objectIds.has("vacuum_connection")) {
    add("filter_flask", "filtration_zone", "filter_flask");
    add("vacuum_source", "filtration_zone", "vacuum_source");
    aliases.set("vacuum_connection", "filter_flask");
  }
  if (objectIds.has("instrument_queue")) {
    add("spectrophotometer", "instrument_zone", "instrument");
  }
  if ([...objectIds].some((id) => id.endsWith("_cuvette"))) add("cuvette_rack_fixture", "cuvette_rack_zone", "rack");

  // A station is part of the observable lab procedure even when it is not a
  // programmable object. Add those fixtures as scene-only context so a
  // destination never degrades into an unexplained labeled pad.
  if (visitedZones.has("balance_zone")) add("balance", "balance_zone", "balance");
  if (visitedZones.has("stand_zone")) add("ring_stand_fixture", "stand_zone", "stand");
  if (visitedZones.has("burette_receiver_zone")) add("burette", "burette_zone", "burette");
  if (visitedZones.has("instrument_zone")) add("spectrophotometer", "instrument_zone", "instrument");
  if (visitedZones.has("chromatography_zone")) add("chromatography_chamber", "chromatography_zone", "chromatography_chamber");
  if (visitedZones.has("oven_zone")) add("drying_oven", "oven_zone", "oven");
  if (visitedZones.has("cooling_zone")) add("cooling_rack", "cooling_zone", "cooling_rack");
  if (visitedZones.has("waste_zone")) add("waste_station_bin", "waste_zone", "secured_carrier");

  const vacuumTechnique = task.techniques.some((technique) => ["gravimetric-vacuum-filtration", "hard-water-gravimetry"].includes(technique));
  if (visitedZones.has("filtration_zone") && vacuumTechnique) {
    if (!hasType("filter_flask")) add("filter_flask_fixture", "filtration_zone", "filter_flask");
    if (!hasType("buchner_funnel")) add("buchner_funnel_fixture", "filtration_zone", "buchner_funnel");
  }
  return { companions, aliases };
}

function initialZoneForObject(objectId, operations) {
  const pickup = operations.find((operation) =>
    ["grasp", "pick_nearest"].includes(operation.type) && operation.objectId === objectId
  );
  if (pickup) return pickup.at;
  const stationary = operations.find((operation) =>
    operation.targetId === objectId || operation.controlId === objectId || operation.instrumentId === objectId
  );
  return stationary ? stationary.at : "work_zone";
}

function stableNumber(value) {
  return [...String(value)].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) >>> 0, 2166136261);
}

function poseValue(robotId, poseId, jointId, min, max) {
  const ratio = stableNumber(`${robotId}:${poseId}:${jointId}`) / 0xffffffff;
  return Number((min + ratio * (max - min)).toFixed(2));
}

function jointsForPose(robotId, poseId) {
  if (poseId === "home") return { ...(HOME_JOINTS[robotId] || {}) };
  if (robotId === "arduino_arm") {
    return {
      base: poseValue(robotId, poseId, "base", 28, 122), shoulder: poseValue(robotId, poseId, "shoulder", 58, 118),
      elbow: poseValue(robotId, poseId, "elbow", 55, 130), wrist_rot: poseValue(robotId, poseId, "wrist_rot", 42, 138),
      wrist_tilt: poseValue(robotId, poseId, "wrist_tilt", 55, 125), gripper: 90
    };
  }
  if (robotId === "so101_follower" || robotId === "lekiwi_sim") {
    return {
      shoulder_pan: poseValue(robotId, poseId, "shoulder_pan", -62, 62), shoulder_lift: poseValue(robotId, poseId, "shoulder_lift", -72, 48),
      elbow_flex: poseValue(robotId, poseId, "elbow_flex", 35, 105), wrist_flex: poseValue(robotId, poseId, "wrist_flex", -28, 72),
      wrist_roll: poseValue(robotId, poseId, "wrist_roll", -72, 72), gripper: 50
    };
  }
  if (robotId === "openarm_v2_bimanual") {
    const baseYaw = poseValue(robotId, poseId, "base_yaw", -70, 70);
    const leftShoulder = poseValue(robotId, poseId, "left_shoulder", -35, 30);
    const elbow = poseValue(robotId, poseId, "elbow", 48, 108);
    return {
      base_yaw: baseYaw,
      left_j1: leftShoulder, left_j2: poseValue(robotId, poseId, "left_j2", -55, -8), left_j3: 0, left_j4: elbow, left_j5: 0, left_j6: -5, left_j7: 0, left_gripper: 12,
      right_j1: -leftShoulder, right_j2: poseValue(robotId, poseId, "right_j2", 8, 55), right_j3: 0, right_j4: elbow, right_j5: 0, right_j6: 5, right_j7: 0, right_gripper: 12
    };
  }
  return {};
}

function requiredPose(operation) {
  if (operation.type === "record_observation") return "current";
  return operation.at || operation.zoneId || "home";
}

function helperAvailableFor(task, poseId) {
  if (["home", "dock", "safety"].includes(poseId)) return true;
  if (task.rank <= 3) return true;
  if (task.rank >= 8) return false;
  return stableNumber(`${task.id}:${poseId}`) % 2 === 0;
}

function planarDistance(a, b) {
  return Math.hypot(Number(a[0]) - Number(b[0]), Number(a[2]) - Number(b[2]));
}

function normalizeDegrees(value) {
  let next = Number(value) || 0;
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return next;
}

function segmentIntersectsCircle(start, end, center, radius) {
  const dx = end[0] - start[0];
  const dz = end[2] - start[2];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((center[0] - start[0]) * dx + (center[2] - start[2]) * dz) / lengthSquared)) : 0;
  return Math.hypot(start[0] + t * dx - center[0], start[2] + t * dz - center[2]) < radius;
}

function hazardConfiguration(task) {
  if (task.id === "lekiwi-08-cooled-precipitate") {
    return { hazards: [{ id: "hot-zone-exclusion", label: "Hot-zone exclusion", centerMm: [0, 0, 185], radiusMm: 72 }], waypoints: [{ id: "safe_route_1", positionMm: [0, 0, 330] }] };
  }
  if (task.id === "g1-07-reagent-tote") {
    return { hazards: [{ id: "restricted-preparation-zone", label: "Restricted preparation zone", centerMm: [0, 0, -100], radiusMm: 82 }], waypoints: [{ id: "safe_route_1", positionMm: [0, 0, 85] }] };
  }
  if (task.id === "g1-10-lab-runner-shift") {
    return { hazards: [{ id: "restricted-liquid-work-zone", label: "Restricted liquid-work zone", centerMm: [335, 0, -150], radiusMm: 72 }], waypoints: [{ id: "safe_route_1", positionMm: [330, 0, 20] }] };
  }
  return { hazards: [], waypoints: [] };
}

function mobileLeg(task, from, to, destinationId, headingDeg) {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const distanceMm = Math.hypot(dx, dz);
  if (distanceMm < 0.5) return { commands: [], headingDeg };
  if (task.robotId === "lekiwi_sim") {
    const seconds = Math.max(0.5, Math.min(3, distanceMm / 350));
    return {
      commands: [{ type: "drive", vx: dx / 1000 / seconds, vy: dz / 1000 / seconds, omega: 0, seconds, frame: "world", destinationId }],
      headingDeg
    };
  }
  const targetHeading = Math.atan2(dz, dx) * 180 / Math.PI;
  const turnAngle = normalizeDegrees(targetHeading - headingDeg);
  const steps = Math.max(1, Math.ceil(distanceMm / 120));
  const commands = [];
  if (Math.abs(turnAngle) > 0.5) commands.push({ type: "humanoid_turn", angleDeg: turnAngle, seconds: 1.2 });
  commands.push({ type: "humanoid_walk", direction: "forward", steps, stepLengthM: distanceMm / steps / 1000, speed: 45, destinationId });
  return { commands, headingDeg: targetHeading };
}

function navigationFor(task, poseId, pose, navigationState, hazards, waypoints) {
  if (poseId === "current") return [];
  if (poseId === "home") {
    navigationState.positionMm = [...ZONE_POSITIONS.home];
    navigationState.headingDeg = 0;
    return [{ type: "home" }];
  }
  const mobile = ["lekiwi_sim", "unitree_g1_29dof"].includes(task.robotId);
  const directHazard = mobile ? hazards.find((hazard) => segmentIntersectsCircle(navigationState.positionMm, pose.positionMm, hazard.centerMm, hazard.radiusMm)) : null;
  if (pose.helperAvailable && !directHazard) {
    if (task.robotId === "unitree_g1_29dof" && planarDistance(navigationState.positionMm, pose.positionMm) > 0.5) {
      navigationState.headingDeg = Math.atan2(pose.positionMm[2] - navigationState.positionMm[2], pose.positionMm[0] - navigationState.positionMm[0]) * 180 / Math.PI;
    }
    navigationState.positionMm = [...pose.positionMm];
    return [{ type: "move_to_pose", poseId, seconds: 1.2 }];
  }
  if (mobile) {
    const commands = [];
    const route = directHazard ? [waypoints[0], { id: poseId, positionMm: pose.positionMm }] : [{ id: poseId, positionMm: pose.positionMm }];
    route.filter(Boolean).forEach((target) => {
      const leg = mobileLeg(task, navigationState.positionMm, target.positionMm, target.id, navigationState.headingDeg);
      commands.push(...leg.commands);
      navigationState.positionMm = [...target.positionMm];
      navigationState.headingDeg = leg.headingDeg;
    });
    return commands;
  }
  return [{ type: "move_joints", joints: pose.joints, speed: 45 }];
}

function checkpointLabel(operation) {
  if (operation.type === "grasp") return `Grasp ${labelFromId(operation.objectId)}`;
  if (operation.type === "place") return `Place ${labelFromId(operation.objectId)} at ${labelFromId(operation.zoneId)}`;
  if (operation.type === "insert_into") return `Insert ${labelFromId(operation.objectId)} into ${labelFromId(operation.targetId)}`;
  if (operation.type === "pour_into") return `Transfer ${labelFromId(operation.objectId)} into ${labelFromId(operation.targetId)}`;
  if (operation.type === "operate") return `${labelFromId(operation.mode)}: ${labelFromId(operation.controlId)}`;
  if (operation.type === "read_instrument") return `Read ${labelFromId(operation.instrumentId)}`;
  if (operation.type === "record_observation") return `Record ${labelFromId(operation.fieldId)}`;
  if (operation.type === "pick_nearest") return `Secure ${labelFromId(operation.objectId)} with ${labelFromId(operation.hand)}`;
  if (operation.type === "release_object") return `Release ${labelFromId(operation.objectId)} at ${labelFromId(operation.zoneId)}`;
  if (operation.type === "home") return "Return robot home";
  return labelFromId(operation.type);
}

function pythonLine(command) {
  const snake = (value) => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const entries = Object.entries(command).filter(([key]) => key !== "type");
  return `robot.${command.type}(${entries.map(([key, value]) => `${snake(key)}=${JSON.stringify(value)}`).join(", ")})`;
}

function sourceActionsForTask(task, techniqueId) {
  const available = SOURCE_ACTIONS[techniqueId] || [];
  const id = task.id;
  let selected = available;
  if (techniqueId === "weighing") selected = ["place-watch-glass"];
  else if (techniqueId === "measuring-volume") selected = ["place-cylinder"];
  else if (techniqueId === "making-solution") selected = ["add-solvent"];
  else if (techniqueId === "dilution") selected = ["transfer-aliquot", "dilute-to-mark"];
  else if (techniqueId === "transmittance-dilution") selected = id.includes("stopper") ? ["stopper-flask", "invert-to-mix"] : ["wipe-blank-cuvette", "zero-with-blank", "record-percent-transmittance"];
  else if (techniqueId === "transfer") selected = id.includes("pour") ? ["transfer-sample"] : ["place-beaker", "transfer-sample"];
  else if (techniqueId === "filtration") selected = id.includes("paper") || id.includes("assembly") ? ["assemble-funnel-stand", "place-filter-paper"] : ["place-filtration-receiver", "filter-mixture"];
  else if (techniqueId === "paper-chromatography") selected = id.includes("spotting") ? ["spot-sample"] : ["develop-paper"];
  else if (techniqueId === "titration-endpoint") {
    if (id.includes("condition") || id.includes("initial-reading")) selected = ["condition-burette", "fill-burette", "remove-burette-funnel", "read-initial-burette"];
    else if (id.includes("receiver") || id.includes("flask-under")) selected = ["position-flask-under-burette"];
    else selected = ["position-flask-under-burette", "deliver-titrant"];
  } else if (techniqueId === "blue1-standard-dilutions") selected = ["i1-r8-2-measure-stock", "i1-r8-2-transfer-stock"];
  else if (techniqueId === "blue1-percent-transmittance") selected = ["i1-r8-2-condition-orient-cuvette", "i1-r8-2-insert-cuvette", "i1-r8-2-read-percent-t"];
  else if (techniqueId === "gravimetric-vacuum-filtration") {
    selected = id.includes("supply") ? ["place-practice-buchner", "seat-practice-filter-paper", "wash-practice-precipitate"] : available;
  } else if (techniqueId === "two-stage-precipitate-drying") {
    selected = id.includes("two-stage") || id.includes("runner") ? available : ["cool-practice-assembly", "weigh-practice-combined"];
  } else if (techniqueId === "crystal-violet-spectrophotometer-calibration") {
    selected = ["cv11-insert-blank", "cv11-zero-spectrophotometer", "cv11-remove-blank", "cv11-read-absorbance-05"];
  } else if (techniqueId === "crystal-violet-waste-treatment") selected = ["cv11-transfer-cv-waste"];
  else if (techniqueId === "quick-ache-extraction-recovery") selected = ["qar-mix-and-vent", "qar-settle-and-observe-layers", "qar-drain-lower-layer"];
  const invalid = selected.filter((actionId) => !available.includes(actionId));
  if (invalid.length) throw new Error(`${task.id} selects unreviewed ${techniqueId} actions: ${invalid.join(", ")}`);
  return selected;
}

function cameraFor(task) {
  if (task.robotId === "unitree_g1_29dof") return { preset: "authored-task", positionMm: [1320, 910, 1510], targetMm: [0, 660, 0], movementDefault: true, zoomDefault: true };
  if (task.robotId === "openarm_v2_bimanual") return { preset: "authored-task", positionMm: [790, 490, 870], targetMm: [0, 200, 0], movementDefault: true, zoomDefault: true };
  if (task.robotId === "lekiwi_sim") return { preset: "authored-task", positionMm: [740, 430, 800], targetMm: [0, 140, 0], movementDefault: true, zoomDefault: true };
  return { preset: "authored-task", positionMm: [620, 350, 690], targetMm: [0, 110, 0], movementDefault: true, zoomDefault: true };
}

function visualPositionFor(robotId, positionMm) {
  // Mobile preview rigs consume the authored world X directly and expose the
  // logical navigation Z on the opposite Three.js axis. Fixed workcells retain
  // their established overview scale.
  if (["lekiwi_sim", "unitree_g1_29dof"].includes(robotId)) {
    return [Number(positionMm[0]), Number(positionMm[1]), -Number(positionMm[2])];
  }
  const scale = robotId === "openarm_v2_bimanual" ? 1 : 0.9;
  return [Number((positionMm[0] * scale).toFixed(1)), positionMm[1], Number((positionMm[2] * scale).toFixed(1))];
}

function buildScenario(task) {
  const operations = task.workflow.map(parseWorkflowLine);
  const routeConfig = hazardConfiguration(task);
  const objectIds = new Set();
  operations.forEach((operation) => {
    ["objectId", "targetId", "controlId", "instrumentId"].forEach((key) => {
      if (operation[key]) objectIds.add(operation[key]);
    });
  });

  const workflowObjectIds = new Set(objectIds);
  const visualScene = sceneCompanions(task, objectIds, operations);
  visualScene.companions.forEach((companion) => objectIds.add(companion.id));
  const companionById = new Map(visualScene.companions.map((companion) => [companion.id, companion]));

  const apparatus = [...objectIds].map((id) => {
    const companion = companionById.get(id);
    const type = companion?.type || typeFromId(id);
    const initialZone = companion?.initialZone || initialZoneForObject(id, operations);
    const fixedHandRobot = task.robotId === "unitree_g1_29dof";
    const securedCarrier = type === "secured_carrier" || (fixedHandRobot && operations.some((operation) => operation.type === "pick_nearest" && operation.objectId === id));
    const compatibleTargets = [...new Set(operations.filter((operation) => ["insert_into", "pour_into"].includes(operation.type) && operation.objectId === id).map((operation) => operation.targetId))];
    const allowedZones = [...new Set(operations.filter((operation) => ["place", "release_object"].includes(operation.type) && operation.objectId === id).map((operation) => operation.zoneId))];
    const requiresStabilization = task.robotId === "openarm_v2_bimanual" && task.skills.some((skill) => skill.includes("bimanual")) && operations.some((operation) => operation.type === "pour_into" && operation.targetId === id);
    const requiredInsertionOrientation = id === "chromatography_paper" ? "origin_above_solvent_line" : compatibleTargets.length ? "upright" : null;
    const visualVariant = visualVariantFor(id, type, compatibleTargets);
    return {
      id,
      label: labelFromId(id),
      accessibleName: labelFromId(id),
      type,
      sceneOnly: !workflowObjectIds.has(id),
      visualParentId: visualScene.aliases.get(id) || null,
      visualReference: visualReferenceFor(id, type, visualVariant),
      visualVariant,
      initialZone,
      positionMm: ZONE_POSITIONS[initialZone] || [0, 0, 0],
      orientation: requiredInsertionOrientation || "upright",
      requiredInsertionOrientation,
      contentsCategory: id.includes("blank") ? "configured blank" : id.includes("waste") ? "closed configured waste" : operations.some((operation) => operation.type === "pour_into" && operation.objectId === id) ? "configured source contents" : "none specified",
      allowedZones,
      compatibleTargets,
      state: {
        cleanliness: "configured",
        contamination: "none simulated",
        temperature: id.includes("cooled") ? "cooled" : id.includes("dried") ? "requires cooling gate" : "ambient",
        calibration: operations.some((operation) => operation.instrumentId === id) ? "configured readiness only" : "not applicable",
        connection: id === "vacuum_connection" ? "disconnected" : "not applicable"
      },
      affordances: {
        graspable: !companion && !["balance", "instrument", "oven", "cooling_rack", "stand", "control", "vacuum_source", "wash_station", "queue_station"].includes(type),
        insertable: ["filter_paper", "chromatography_paper", "cuvette", "funnel", "pipette"].includes(type),
        pourable: operations.some((operation) => operation.type === "pour_into" && operation.objectId === id),
        receivable: operations.some((operation) => ["insert_into", "pour_into"].includes(operation.type) && operation.targetId === id),
        operable: operations.some((operation) => operation.controlId === id),
        readable: operations.some((operation) => operation.instrumentId === id),
        securedCarrier,
        requiresStabilization
      },
      compatibleEffectors: fixedHandRobot ? (securedCarrier ? ["left_hand", "right_hand"] : []) : task.robotId === "openarm_v2_bimanual" ? ["left", "right"] : ["default"]
    };
  });

  const poseIds = new Set(["home", "dock", "safety"]);
  operations.forEach((operation) => {
    const poseId = requiredPose(operation);
    if (poseId !== "current") poseIds.add(poseId);
  });
  routeConfig.waypoints.forEach((waypoint) => poseIds.add(waypoint.id));
  visualScene.companions.forEach((companion) => poseIds.add(companion.initialZone));
  const waypointPositions = Object.fromEntries(routeConfig.waypoints.map((waypoint) => [waypoint.id, waypoint.positionMm]));
  const robotPoses = {};
  [...poseIds].forEach((poseId) => {
    robotPoses[poseId] = {
      id: poseId,
      label: labelFromId(poseId),
      helperAvailable: helperAvailableFor(task, poseId),
      joints: jointsForPose(task.robotId, poseId),
      positionMm: waypointPositions[poseId] || ZONE_POSITIONS[poseId] || [0, 0, 0],
      tolerance: { jointDeg: 2.5, positionMm: 35 }
    };
  });
  if (task.rank >= 4 && task.rank <= 7) {
    const taskPoseIds = [...poseIds].filter((poseId) => !["home", "dock", "safety"].includes(poseId)).sort();
    taskPoseIds.forEach((poseId, index) => { robotPoses[poseId].helperAvailable = index % 2 === 0; });
  }
  routeConfig.waypoints.forEach((waypoint) => { robotPoses[waypoint.id].helperAvailable = false; });

  const checkpoints = operations.map((operation, index) => ({
    id: `cp-${String(index + 1).padStart(2, "0")}`,
    label: checkpointLabel(operation),
    sourceBasis: operation.type === "home" || operation.type === "record_observation" ? ["C"] : ["grasp", "place", "pick_nearest", "release_object"].includes(operation.type) ? ["R", "C"] : ["M", "R"],
    expected: { ...operation, requiredPose: requiredPose(operation) },
    prerequisites: index ? [`cp-${String(index).padStart(2, "0")}`] : [],
    evidence: { category: "completion", event: `${operation.type}:${operation.objectId || operation.controlId || operation.instrumentId || operation.fieldId || "robot"}` },
    invalidFeedback: `${checkpointLabel(operation)} is unavailable until the robot is at ${labelFromId(requiredPose(operation))} and earlier checkpoints are complete.`,
    recovery: `Move to ${labelFromId(requiredPose(operation))}, verify effector and object state, then retry this checkpoint.`
  }));

  const success = [];
  const navigationState = { positionMm: [...robotPoses.home.positionMm], headingDeg: 0 };
  operations.forEach((operation) => {
    const poseId = requiredPose(operation);
    const pose = poseId === "current" ? null : robotPoses[poseId];
    if (operation.type !== "home") success.push(...navigationFor(task, poseId, pose, navigationState, routeConfig.hazards, routeConfig.waypoints));
    success.push({ ...operation });
    if (operation.type === "home") {
      navigationState.positionMm = [...robotPoses.home.positionMm];
      navigationState.headingDeg = 0;
    }
  });
  const firstAction = operations.find((operation) => operation.type !== "home") || operations[0];
  const firstPoseId = requiredPose(firstAction);
  const recoveryState = { positionMm: [...robotPoses.home.positionMm], headingDeg: 0 };
  const recoveryNavigation = navigationFor(task, firstPoseId, robotPoses[firstPoseId], recoveryState, routeConfig.hazards, routeConfig.waypoints);
  const invalidRecovery = [
    { command: { ...firstAction }, expectedError: "NOT_IN_PROXIMITY" },
    ...recoveryNavigation.map((command) => ({ command, expected: "recovery navigation accepted" })),
    { command: { ...firstAction }, expected: "first checkpoint completed" }
  ];

  const allowedCommands = new Set(["home", "stop", "wait", "move_joint", "move_joints", ...operations.map((operation) => operation.type)]);
  if (task.robotId !== "unitree_g1_29dof") allowedCommands.add("set_gripper");
  if (task.robotId === "lekiwi_sim") allowedCommands.add("drive");
  if (task.robotId === "unitree_g1_29dof") {
    ["humanoid_walk", "humanoid_turn", "set_posture"].forEach((command) => allowedCommands.add(command));
    ["grasp", "place", "pour_into", "insert_into"].forEach((command) => allowedCommands.delete(command));
  }
  const starterCount = task.rank <= 3 ? Math.min(4, success.length) : task.rank <= 7 ? Math.min(2, success.length) : 0;
  const starterCommands = success.slice(0, starterCount);

  return {
    schema: "robobuddy.lab-scenario.v1",
    version: 1,
    id: task.id,
    robotId: task.robotId,
    rank: task.rank,
    assistanceLevel: assistanceFor(task.rank),
    title: task.title,
    brief: task.brief,
    audience: "High-school chemistry and introductory robotics",
    estimatedComplexity: complexityFor(task.rank),
    skills: task.skills,
    languages: ["blockly", "python"],
    objectives: [
      `Program ${ROBOTS[task.robotId].label} to complete the observable handling sequence.`,
      "Use checkpoint feedback to recover from invalid proximity, sequence, or compatibility states.",
      "Distinguish simulated apparatus state from learner-recorded evidence."
    ],
    successCriteria: checkpoints.map((checkpoint) => checkpoint.label),
    techniqueRefs: task.techniques.map((techniqueId) => ({
      techniqueId,
      basis: "M",
      actionIds: sourceActionsForTask(task, techniqueId),
      scope: "These source actions establish the cited apparatus or station sequence; robot motion, carriers, tolerances, and helper poses are authored configuration."
    })),
    morphologyBasis: { basis: "R", statement: `Source technique actions are assigned to the capabilities of the ${ROBOTS[task.robotId].form}.` },
    configurationBasis: { basis: "C", statement: "Station positions, robot poses, timing, tolerances, secured carriers, and simulated instrument states are authored educational configuration." },
    requiredCapabilities: [
      task.robotId === "unitree_g1_29dof" ? "fixed_hand_interaction" : "joint_control",
      task.robotId === "openarm_v2_bimanual" ? "bimanual_control" : task.robotId === "lekiwi_sim" ? "holonomic_drive" : "home",
      task.robotId === "unitree_g1_29dof" ? "secured_carrier_attachment" : "gripper_control"
    ],
    allowedCommands: [...allowedCommands],
    limitations: ROBOTS[task.robotId].limitations,
    simulationBoundary: "Programming and procedural-technique simulation only. This activity is not authorization or instruction for physical laboratory work.",
    safetyBoundary: "No real chemicals or robot hardware are controlled. Authored thermal, contamination, restricted-zone, connection, and sequence gates remain enforceable in simulation.",
    camera: cameraFor(task),
    navigationHazards: routeConfig.hazards.map((hazard) => ({
      ...hazard,
      visualCenterMm: visualPositionFor(task.robotId, hazard.centerMm)
    })),
    zones: Object.values(robotPoses).map((pose) => ({
      id: pose.id,
      label: pose.label,
      positionMm: pose.positionMm,
      visualPositionMm: visualPositionFor(task.robotId, pose.positionMm),
      radiusMm: 70,
      hazard: pose.id.includes("oven") ? "hot zone" : pose.id.includes("waste") ? "configured waste zone" : "none"
    })),
    robotPoses,
    apparatus,
    checkpoints,
    starters: {
      blockly: { commands: starterCommands },
      python: { code: starterCommands.map(pythonLine).join("\n") }
    },
    traces: { success, invalidRecovery },
    reset: {
      preserve: ["camera movement preference", "camera zoom preference", "Blockly draft", "Python draft"],
      reconstruct: ["robot pose", "apparatus state", "checkpoint progress", "simulated evidence log"]
    }
  };
}

function buildIndex() {
  return {
    schema: "robobuddy.lab-catalog.v1",
    version: 1,
    generatedOn: "2026-08-12",
    audience: "High-school chemistry and introductory robotics",
    languages: ["en"],
    robots: Object.entries(ROBOTS).map(([id, robot]) => ({ id, label: robot.label, form: robot.form, taskCount: 10, limitations: robot.limitations })),
    tasks: TASKS.map((task) => ({
      id: task.id,
      robotId: task.robotId,
      rank: task.rank,
      title: task.title,
      techniques: task.techniques,
      brief: task.brief,
      skills: task.skills,
      assistanceLevel: assistanceFor(task.rank),
      complexity: complexityFor(task.rank),
      languages: ["blockly", "python"],
      limitations: ROBOTS[task.robotId].limitations,
      definition: `missions/lab-assistant/v1/${task.id}.json`
    }))
  };
}

function buildLedger() {
  return {
    schema: "robobuddy.lab-source-ledger.v1",
    version: 1,
    authority: "Reviewed Lab Studio public technique definitions supplied by the user as the procedural source. The runtime does not import Lab Studio.",
    evidenceLegend: { M: "Manual/source-stated", F: "Figure/table-supported", R: "Real-life implicit", C: "Configuration choice" },
    provenanceCategories: ["configured", "simulator-generated", "learner-recorded", "calculated", "extrapolated"],
    techniques: Object.keys(SOURCE_TITLES).map((id) => ({
      id,
      title: SOURCE_TITLES[id],
      basis: "M",
      reviewedActionIds: SOURCE_ACTIONS[id],
      sourceLocator: `Lab Studio technique:${id}`,
      browserClaim: "Only named action identities and ordering constraints are copied; no local paths, hashes, hidden results, or numeric endpoints are included."
    })),
    globalClaims: [
      { id: "claim-simulation-only", basis: "C", statement: "All tasks are simulation-only procedural and robot-programming exercises." },
      { id: "claim-kinematic", basis: "C", statement: "Robot and apparatus movement is deterministic and kinematic; no fluid, torque, rigid-body, autonomous planning, or dynamic-balance claim is made." },
      { id: "claim-morphology", basis: "R", statement: "Technique actions are assigned to each robot morphology only where its simulated effector and movement model can represent the handling role." }
    ]
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

await writeJson(resolve(OUTPUT_ROOT, "index.json"), buildIndex());
await writeJson(resolve(OUTPUT_ROOT, "source-ledger.json"), buildLedger());
for (const task of TASKS) {
  await writeJson(resolve(OUTPUT_ROOT, "v1", `${task.id}.json`), buildScenario(task));
}
console.log(`Generated ${TASKS.length} lab-assistant scenarios in ${OUTPUT_ROOT}`);
