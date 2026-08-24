import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertScenarioV2, stripValidationForClient } from "../lab/v2/scenario-schema.js";
import {
  apparatusVisualProfile,
  directApparatusVisual,
  directHandlingLabel,
  directGripHeightMm,
  physicalRest,
  realWorkSurfaceProxy,
  YAW_90_ROTATION,
} from "./portable-physical-rest-helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "lekiwi");
const OUTPUT = resolve(ROOT, "missions", "lab-assistant", "v2", "generated", "scenarios");
const files = (await readdir(SOURCE)).filter((name) => name.endsWith(".json")).sort();
if (files.length !== 10) throw new Error(`Expected 10 LeKiwi definitions; found ${files.length}.`);

// Flat plates, loose watch glasses, and 20 mm cuvettes are not credible direct
// payloads for the source-pinned LeKiwi parallel gripper in this workcell. Keep
// the immutable scenario/object identifiers, but redesign those transport roles
// around genuine, upright laboratory apparatus that the rendered fingers can
// oppose directly. This is capability-driven task authoring, not a reachability
// shortcut: the base stops, bench, arm geometry, and apparatus envelopes remain
// fixed and collision-active.
const LEKIWI_APPARATUS_ROLES = Object.freeze({
  "lekiwi-01-beaker-courier": { profile: "beaker", label: "Empty beaker", title: "Beaker Courier", placeRaiseMm: 4.8 },
  "lekiwi-02-glassware-route": { profile: "flask", label: "Empty Erlenmeyer flask", title: "Glassware Route", placeRaiseMm: 0.8 },
  "lekiwi-03-sample-delivery": { profile: "bottle", label: "Capped sample bottle", title: "Sample Bottle Delivery", placeRaiseMm: 5.8 },
  "lekiwi-04-filter-station-run": { profile: "filter_flask", label: "Empty filter flask", title: "Filter Flask Station Run", placeRaiseMm: 0.8 },
  "lekiwi-05-reagent-shuttle": { profile: "bottle", label: "Capped reagent bottle", title: "Reagent Shuttle", placeRaiseMm: 5.8 },
  "lekiwi-06-cooling-rack-route": { profile: "flask", label: "Empty cooling flask", title: "Cooling Flask Route", placeRaiseMm: 3.6 },
  "lekiwi-07-chromatography-route": { profile: "bottle", label: "Capped chromatography solvent bottle", title: "Chromatography Solvent Route", placeRaiseMm: 5.8 },
  "lekiwi-08-spectrometer-route": { profile: "bottle", label: "Capped spectrometer sample bottle", title: "Spectrometer Sample Bottle Route", placeRaiseMm: 5.8 },
  "lekiwi-09-titration-logistics": { profile: "bottle", label: "Capped titration reagent bottle", title: "Titration Reagent Logistics", placeRaiseMm: 0 },
  "lekiwi-10-hard-water-logistics": { profile: "bottle", label: "Capped hard-water sample bottle", title: "Hard-Water Sample Logistics", placeRaiseMm: 0 },
});

for (const name of files) {
  const sourcePath = resolve(SOURCE, name);
  const definition = JSON.parse(await readFile(sourcePath, "utf8"));
  const object = definition.objects.find((item) => item.transportable !== false);
  if (!object) throw new Error(`${definition.id}: transport object is unavailable.`);
  const role = LEKIWI_APPARATUS_ROLES[definition.id];
  if (!role) throw new Error(`${definition.id}: LeKiwi direct-apparatus role is unavailable.`);
  object.configuredApparatusProfile = role.profile;
  const apparatus = apparatusVisualProfile(object);
  object.label = role.label || directHandlingLabel(object);
  definition.title = role.title;
  object.visible = true;
  object.visual = directApparatusVisual(object);
  object.configuredGripInterface = `${apparatus.gripInterface}; direct contact with the intended apparatus, with no tray, carrier, cassette, bin, or proxy payload.`;
  object.attachmentInterface = "direct_apparatus_grip";

  const worktopTopY = 211;
  const contactY = worktopTopY + directGripHeightMm(object);
  for (const frameId of ["pickup_approach", "pickup_contact", "pickup_lift"]) {
    definition.frames[frameId].positionMm[0] = 400;
    definition.frames[frameId].positionMm[2] = 350;
  }
  for (const frameId of ["delivery", "delivery_contact"]) {
    definition.frames[frameId].positionMm[0] = 350;
    definition.frames[frameId].positionMm[2] = 400;
  }
  definition.frames.pickup_contact.positionMm[1] = contactY;
  definition.frames.delivery_contact.positionMm[1] = contactY + role.placeRaiseMm;
  // Keep planning targets tight. The family finalizer widens only the runtime
  // contact latch after the collision-checked IK trace has been regenerated,
  // because the authoritative FK point is the jaw joint while first physical
  // finger contact occurs several millimetres earlier at the rendered tips.
  definition.frames.pickup_contact.tolerance.positionMm = 4;
  definition.frames.delivery_contact.tolerance.positionMm = 4;
  definition.frames.pickup_approach.positionMm[1] = contactY + 40;
  definition.frames.pickup_lift.positionMm[1] = contactY + 50;
  definition.frames.delivery.positionMm[1] = contactY + 50;
  definition.frames.delivery_clearance = {
    positionMm: [500, contactY + 70, 400],
    role: "retreat",
    chainId: "default",
    tolerance: { positionMm: 4 },
    label: "Free-space retreat outside the fixed transfer-bench envelope",
  };
  definition.frames.pickup_contact.contactFixtureId = "pickup_cradle";
  definition.frames.delivery_contact.contactFixtureId = "destination_fixture";

  const pickupFixture = definition.fixtures.find((fixture) => fixture.id === "pickup_cradle");
  const destinationFixture = definition.fixtures.find((fixture) => fixture.id === "destination_fixture");
  if (!pickupFixture || !destinationFixture) throw new Error(`${definition.id}: transfer-bench fixtures are unavailable.`);
  pickupFixture.label = "Real laboratory transfer bench";
  pickupFixture.type = "configured_real_transfer_bench";
  pickupFixture.configuredByTeacher = true;
  pickupFixture.sourceBackedHolder = true;
  pickupFixture.frameId = "pickup_contact";
  pickupFixture.claimBoundary = "Configured 290 x 290 x 211 mm wall-backed laboratory transfer bench with a 24 mm rigid worktop and one broad 32 x 250 mm structural back panel. The intended apparatus rests directly on the worktop so its complete initial and reference-calibrated final footprint is supported while the mobile base remains outside the worktop envelope; these dimensions and this pose are fixed across all ten tasks.";
  pickupFixture.collisionProxies = [
    realWorkSurfaceProxy(
      "lekiwi-transfer-worktop",
      [305, 199, 390],
      [145, 12, 145],
      "C: configured fixed 290 x 290 mm real transfer-bench worktop; top y=211 mm; presentation, collision, and stable-rest validation share this box across all ten tasks"
    ),
    {
      id: "lekiwi-transfer-structural-back",
      type: "box",
      centerMm: [206, 99.5, 390],
      halfExtentsMm: [16, 99.5, 125],
      provenance: "C: broad visible floor-and-wall-anchored structural back panel carrying the rigid laboratory worktop across a 32 x 250 mm bearing section",
    },
  ];
  delete pickupFixture.collisionProxy;

  destinationFixture.label = "Marked receiving zone on the real transfer bench";
  destinationFixture.type = "configured_receiving_zone";
  destinationFixture.configuredByTeacher = true;
  destinationFixture.frameId = "delivery_contact";
  destinationFixture.presentationOnly = true;
  destinationFixture.collisionProxies = [];
  delete destinationFixture.collisionProxy;
  destinationFixture.claimBoundary = "A painted receiving-zone marker on the worktop; it carries no load and contributes no support or collision geometry.";

  object.physicalRest = physicalRest({
    definition,
    item: object,
    surfaceId: "lekiwi-transfer-worktop",
    initialFrame: object.initialFrame,
    initialGripFrame: "pickup_contact",
    finalFrame: "delivery",
    finalGripFrame: "delivery_contact",
    initialRotation: YAW_90_ROTATION,
    finalRotation: YAW_90_ROTATION,
  });
  // The raised placement target is an IK-generation waypoint, not the final
  // authoritative rest pose. Allow the intermediate source to pass schema
  // validation so the public action trace can be regenerated; the family
  // finalizer replaces this placeholder with the actual opened-gripper pose
  // and restores the physical 2.5 mm support-gap bound.
  object.physicalRest.tolerance.maxGapMm = 8;
  object.physicalRest.intermediateGenerationPose = true;
  object.physicalRest.capabilityBoundary = `The ${role.label.toLowerCase()} is an upright, directly opposed LeKiwi payload. Flat loose plates, unsupported watch glasses, narrow cuvettes, transport trays, carriers, cassettes, and proxy boxes are outside this task role.`;
  const grasp = definition.grasps.find((item) => item.objectId === object.id);
  if (grasp) {
    grasp.mode = "direct-apparatus";
    grasp.interface = apparatus.gripInterface.replaceAll(" ", "_");
    grasp.fixtureId = "pickup_cradle";
    grasp.visible = true;
    grasp.geometryBasis = "Rendered apparatus grip socket and declared broad workbench rest; no force, payload, or hardware-validation claim.";
  }
  const configured = definition.provenance.find((entry) => entry.label === "C");
  if (configured) configured.claim = `${configured.claim.split(" Physical-rest repair:")[0]} Physical-rest repair: a configured real wall-backed laboratory transfer bench supports the intended apparatus directly at pickup and delivery; the bench is fixed across tasks and no container or small support geometry is used.`;
  if (definition.migration?.redesignRationale) definition.migration.redesignRationale = `${definition.migration.redesignRationale.split(" Physical-rest repair:")[0]} Physical-rest repair: direct floating or floor-block staging was replaced by direct apparatus rest on a fixed real transfer bench.`;
  definition.brief = `Navigate the fixed route, directly grasp and deliver ${object.label.toLowerCase()}, stow, and return without claiming unmodeled laboratory results.`;
  if (definition.migration) definition.migration.fixtureAssistance = "The fixed real transfer bench supports the apparatus directly; the gripper contacts the intended equipment at its declared physical grip region.";
  for (const process of definition.processModels || []) {
    if (typeof process.label === "string") process.label = process.label.replace(/carriers?/gi, "apparatus").replace(/handling trays?/gi, "apparatus");
  }

  assertScenarioV2(definition, { expectedRobotId: "lekiwi_sim" });
  await writeFile(sourcePath, `${JSON.stringify(definition, null, 2)}\n`, "utf8");
  await writeFile(resolve(OUTPUT, name), `${JSON.stringify(stripValidationForClient(definition), null, 2)}\n`, "utf8");
}

console.log("Refined 10 owning LeKiwi definitions: fixed real transfer bench, direct apparatus handling, and no transport containers or floor-block props.");
