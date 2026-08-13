import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
if (sourceIndex < 0 || !args[sourceIndex + 1]) {
  console.error("Usage: node scripts/verify-lab-apparatus-references.mjs --source <Lab Studio equipment-realistic/v1 directory>");
  process.exit(2);
}

const sourceRoot = resolve(args[sourceIndex + 1]);
const ledgerPath = resolve(REPO_ROOT, "missions/lab-assistant/apparatus-reference-ledger.json");
const scenarioRoot = resolve(REPO_ROOT, "missions/lab-assistant/v1");
const ledgerText = await readFile(ledgerPath, "utf8");
const ledger = JSON.parse(ledgerText);
const errors = [];
const implementedVisualTypes = new Set([
  "balance", "watch_glass", "weigh_boat", "beaker", "cylinder", "flask", "filter_flask", "stopper", "cuvette",
  "filter_paper", "chromatography_paper", "funnel", "buchner_funnel", "separatory_funnel", "burette", "stand",
  "pipette", "pipette_pump", "bottle", "instrument", "oven", "cooling_rack", "rack", "secured_carrier",
  "chromatography_chamber", "vacuum_source", "wash_station", "queue_station", "tool"
]);

function ledgerKey(type, visualVariant) {
  return `${type}|${visualVariant}`;
}

function validReferenceName(value) {
  return typeof value === "string" && value.length > 4 && !isAbsolute(value) && basename(value) === value && value.toLowerCase().endsWith(".png");
}

function sameVector(actual, expected) {
  return Array.isArray(actual) && actual.length === 3 && actual.every((value, index) => Number(value) === Number(expected[index]));
}

function expectedVisualPosition(robotId, positionMm) {
  if (["lekiwi_sim", "unitree_g1_29dof"].includes(robotId)) {
    return [Number(positionMm[0]), Number(positionMm[1]), -Number(positionMm[2])];
  }
  const scale = robotId === "openarm_v2_bimanual" ? 1 : 0.9;
  return [Number((positionMm[0] * scale).toFixed(1)), Number(positionMm[1]), Number((positionMm[2] * scale).toFixed(1))];
}

function expectedCarrierVariant(id) {
  const value = String(id || "").toLowerCase();
  if (value.includes("rack")) return "rack";
  if (value.includes("bin")) return "bin";
  if (value.includes("tote")) return "tote";
  if (value.includes("tray")) return "tray";
  return "carrier";
}

if (ledger.schema !== "robobuddy.lab-apparatus-reference-ledger.v2" || ledger.version !== 2) {
  errors.push(`Unsupported apparatus ledger schema/version: ${ledger.schema || "(missing)"}/${ledger.version || "(missing)"}`);
}

const entryIds = new Set();
const ledgerByMatch = new Map();
for (const entry of ledger.entries || []) {
  if (!entry.id || entryIds.has(entry.id)) errors.push(`Duplicate or missing ledger entry id: ${entry.id || "(missing)"}`);
  entryIds.add(entry.id);
  const runtimeType = entry.runtimeMatch?.type;
  const runtimeVariant = entry.runtimeMatch?.visualVariant;
  const matchKey = ledgerKey(runtimeType, runtimeVariant);
  if (!runtimeType || !runtimeVariant) errors.push(`${entry.id || "(missing)"} lacks runtimeMatch.type or runtimeMatch.visualVariant`);
  else if (ledgerByMatch.has(matchKey)) errors.push(`Duplicate ledger runtime match: ${matchKey}`);
  else ledgerByMatch.set(matchKey, entry);
  if (!implementedVisualTypes.has(runtimeType)) errors.push(`${entry.id || "(missing)"} names unsupported runtime type ${runtimeType || "(missing)"}`);
  if (!entry.factoryVariant || entry.factoryVariant !== runtimeVariant) {
    errors.push(`${entry.id || "(missing)"} factoryVariant must equal runtimeMatch.visualVariant`);
  }
  if (!Array.isArray(entry.sourceFeatures) || !entry.sourceFeatures.length || entry.sourceFeatures.some((value) => typeof value !== "string" || !value.trim())) {
    errors.push(`${entry.id || "(missing)"} requires non-empty sourceFeatures`);
  }
  if (!Array.isArray(entry.authoredExtensions) || entry.authoredExtensions.some((value) => typeof value !== "string" || !value.trim())) {
    errors.push(`${entry.id || "(missing)"} authoredExtensions must be an array of non-empty strings`);
  }
  if (!Array.isArray(entry.alternateReferences)) errors.push(`${entry.id || "(missing)"} alternateReferences must be an array`);
  if (Object.hasOwn(entry, "features")) errors.push(`${entry.id || "(missing)"} uses legacy features; separate sourceFeatures from authoredExtensions`);
  for (const referenceName of [entry.asset, ...(entry.alternateReferences || [])]) {
    if (!validReferenceName(referenceName)) {
      errors.push(`${entry.id || "(missing)"} has unsafe or invalid reference name: ${referenceName || "(missing)"}`);
      continue;
    }
    try {
      await access(resolve(sourceRoot, referenceName));
    } catch {
      errors.push(`Missing Lab Studio reference asset for ${entry.id}: ${referenceName}`);
    }
  }
}

const scenarioFiles = (await readdir(scenarioRoot)).filter((name) => name.endsWith(".json")).sort();
if (scenarioFiles.length !== 50) errors.push(`Expected 50 scenario definitions, found ${scenarioFiles.length}`);
let apparatusCount = 0;
let sceneOnlyCount = 0;
let aliasCount = 0;
const usedLedgerEntries = new Set();
const scenarioTexts = [];

for (const file of scenarioFiles) {
  const scenarioText = await readFile(resolve(scenarioRoot, file), "utf8");
  scenarioTexts.push(scenarioText);
  const definition = JSON.parse(scenarioText);
  const ids = new Set(definition.apparatus.map((item) => item.id));
  const apparatusById = new Map(definition.apparatus.map((item) => [item.id, item]));
  const types = new Set(definition.apparatus.map((item) => item.type));
  const zonesById = new Map((definition.zones || []).map((zone) => [zone.id, zone]));
  const visitedZones = new Set(definition.checkpoints.flatMap((checkpoint) => [checkpoint.expected?.at, checkpoint.expected?.zoneId]).filter(Boolean));
  const requiredStationTypes = {
    balance_zone: ["balance"],
    stand_zone: ["stand"],
    burette_receiver_zone: ["burette"],
    instrument_zone: ["instrument"],
    chromatography_zone: ["chromatography_chamber"],
    oven_zone: ["oven"],
    cooling_zone: ["cooling_rack"]
  };
  for (const [zoneId, requiredTypes] of Object.entries(requiredStationTypes)) {
    if (visitedZones.has(zoneId) && !requiredTypes.every((type) => types.has(type))) {
      errors.push(`${definition.id}:${zoneId} lacks visual station fixture ${requiredTypes.join("+")}`);
    }
  }

  const techniqueIds = new Set((definition.techniqueRefs || []).map((reference) => reference.techniqueId));
  if (visitedZones.has("filtration_zone") && [...techniqueIds].some((id) => ["gravimetric-vacuum-filtration", "hard-water-gravimetry"].includes(id))) {
    if (!types.has("filter_flask") || !types.has("buchner_funnel")) errors.push(`${definition.id}:filtration_zone lacks the filter flask and Buchner workstation context`);
  }
  if (visitedZones.has("waste_zone") && !ids.has("waste_station_bin")) errors.push(`${definition.id}:waste_zone lacks a destination waste fixture`);

  for (const zone of definition.zones || []) {
    if (!sameVector(zone.visualPositionMm, expectedVisualPosition(definition.robotId, zone.positionMm))) {
      errors.push(`${definition.id}:${zone.id} visualPositionMm does not match the ${definition.robotId} world transform`);
    }
  }
  for (const hazard of definition.navigationHazards || []) {
    if (!sameVector(hazard.visualCenterMm, expectedVisualPosition(definition.robotId, hazard.centerMm))) {
      errors.push(`${definition.id}:${hazard.id} visualCenterMm does not match the ${definition.robotId} world transform`);
    }
  }

  for (const item of definition.apparatus) {
    apparatusCount += 1;
    if (item.sceneOnly) sceneOnlyCount += 1;
    const initialZone = zonesById.get(item.initialZone);
    if (initialZone && !sameVector(item.positionMm, initialZone.positionMm)) {
      errors.push(`${definition.id}:${item.id} logical position differs from its initial-zone position`);
    }
    if (typeof item.visualVariant !== "string" || !item.visualVariant) errors.push(`${definition.id}:${item.id} lacks visualVariant`);
    if (item.visualParentId) {
      aliasCount += 1;
      const parent = apparatusById.get(item.visualParentId);
      if (!parent) errors.push(`${definition.id}:${item.id} aliases missing ${item.visualParentId}`);
      if (item.visualParentId === item.id) errors.push(`${definition.id}:${item.id} aliases itself`);
      if (parent && item.visualReference !== parent.visualReference) {
        errors.push(`${definition.id}:${item.id} alias reference differs from parent ${item.visualParentId}`);
      }
    }
    if (item.type === "control" && !item.visualParentId) errors.push(`${definition.id}:${item.id} is a control without an apparatus parent visual`);
    if (item.type !== "control" && !implementedVisualTypes.has(item.type)) errors.push(`${definition.id}:${item.id} would use the generic visual fallback for type ${item.type}`);
    if (!validReferenceName(item.visualReference) || item.visualReference === "unmatched-approximation") {
      errors.push(`${definition.id}:${item.id} has no safe reviewed visual reference`);
    }

    if (item.type !== "control") {
      const match = ledgerByMatch.get(ledgerKey(item.type, item.visualVariant));
      if (!match) {
        errors.push(`${definition.id}:${item.id} has no ledger match for ${item.type}|${item.visualVariant}`);
      } else {
        usedLedgerEntries.add(match.id);
        if (item.visualReference !== match.asset) {
          errors.push(`${definition.id}:${item.id} reference ${item.visualReference} does not match ledger primary ${match.asset}`);
        }
        if (item.visualVariant !== match.factoryVariant) {
          errors.push(`${definition.id}:${item.id} visualVariant does not match ledger factoryVariant`);
        }
      }
    }

    if (item.type === "filter_paper") {
      const targets = new Set(item.compatibleTargets || []);
      const gravity = targets.has("gravity_funnel");
      const buchner = targets.has("buchner_funnel");
      if (gravity === buchner) errors.push(`${definition.id}:${item.id} must target exactly one of gravity_funnel or buchner_funnel`);
      const expectedVariant = buchner ? "buchner_disc" : "gravity_cone";
      const expectedReference = buchner ? "filter-paper.png" : "funnel-filter-paper.png";
      if (item.visualVariant !== expectedVariant || item.visualReference !== expectedReference) {
        errors.push(`${definition.id}:${item.id} does not use the context-sensitive ${expectedVariant} reference contract`);
      }
    }
    if (item.type === "secured_carrier" && item.visualVariant !== expectedCarrierVariant(item.id)) {
      errors.push(`${definition.id}:${item.id} secured-carrier variant should be ${expectedCarrierVariant(item.id)}`);
    }
    if (["rack", "queue_station"].includes(item.type) && item.visualVariant !== "rack") {
      errors.push(`${definition.id}:${item.id} rack-family object must use visualVariant rack`);
    }
  }
}

for (const entry of ledger.entries || []) {
  if (!usedLedgerEntries.has(entry.id)) errors.push(`Ledger entry is not exercised by the 50-scenario catalog: ${entry.id}`);
}

const clientPayload = `${ledgerText}\n${scenarioTexts.join("\n")}`;
if (/(?:[A-Za-z]:\\|\/Users\/|\/home\/)|\bsha256\b|\bfile_id\b|\bsourcePath\b/i.test(clientPayload)) {
  errors.push("Client-visible apparatus metadata contains a local path, hash, or vendor file identifier.");
}

if (errors.length) {
  console.error(`Lab apparatus reference verification failed (${errors.length}):`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(`Lab apparatus references verified: ${ledger.entries.length} visual contracts, ${scenarioFiles.length} scenarios, ${apparatusCount} apparatus records, ${sceneOnlyCount} companion props, ${aliasCount} visual aliases.`);
