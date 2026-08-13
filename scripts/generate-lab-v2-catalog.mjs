import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertScenarioV2, clientScenarioPath, stripValidationForClient } from "../lab/v2/scenario-schema.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const V2 = resolve(ROOT, "missions", "lab-assistant", "v2");
const DEFINITIONS = resolve(V2, "definitions");
const GENERATED = resolve(V2, "generated");
const METADATA = resolve(GENERATED, "build-metadata.json");
const ROBOT_ORDER = ["arduino_arm", "so101_follower", "lekiwi_sim", "openarm_v2_bimanual", "unitree_g1_29dof"];

try {
  await readFile(METADATA, "utf8");
  throw new Error("The v2 combined catalog was already generated. Refusing an unreviewed second regeneration.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const files = [];
for (const family of await readdir(DEFINITIONS, { withFileTypes: true })) {
  if (!family.isDirectory()) continue;
  for (const name of await readdir(resolve(DEFINITIONS, family.name))) {
    if (name.endsWith(".json")) files.push(resolve(DEFINITIONS, family.name, name));
  }
}

const definitions = [];
for (const path of files.sort()) {
  const definition = JSON.parse(await readFile(path, "utf8"));
  assertScenarioV2(definition);
  definitions.push(definition);
}
if (definitions.length !== 50) throw new Error(`Expected 50 ScenarioV2 sources; found ${definitions.length}.`);

const ids = new Set();
const supersedes = new Set();
for (const definition of definitions) {
  if (ids.has(definition.id)) throw new Error(`Duplicate v2 id: ${definition.id}.`);
  if (supersedes.has(definition.supersedes)) throw new Error(`Duplicate v1 successor mapping: ${definition.supersedes}.`);
  ids.add(definition.id);
  supersedes.add(definition.supersedes);
}
for (const robotId of ROBOT_ORDER) {
  const tasks = definitions.filter((item) => item.robotId === robotId).sort((a, b) => a.rank - b.rank);
  if (tasks.length !== 10 || tasks.some((task, index) => task.rank !== index + 1)) throw new Error(`${robotId} must have ranks 1..10 exactly once.`);
}

await mkdir(resolve(GENERATED, "scenarios"), { recursive: true });
for (const definition of definitions) {
  await writeFile(resolve(GENERATED, "scenarios", `${definition.id}.json`), `${JSON.stringify(stripValidationForClient(definition), null, 2)}\n`, "utf8");
}

const tasks = definitions.sort((a, b) => ROBOT_ORDER.indexOf(a.robotId) - ROBOT_ORDER.indexOf(b.robotId) || a.rank - b.rank).map((item) => ({
  id: item.id,
  robotId: item.robotId,
  rank: item.rank,
  title: item.title,
  brief: item.brief,
  assistanceLevel: item.assistanceLevel,
  apiLevel: item.api.level,
  migrationClass: item.migration.class,
  supersedes: item.supersedes,
  learningObjective: item.migration.legacyLearningObjective,
  provenanceLabels: [...new Set(item.provenance.map((entry) => entry.label))],
  supportedFidelity: item.modelClaim.supportedFidelity,
  limitations: item.modelClaim.unsupportedPhysics.join("; "),
  definition: clientScenarioPath(item)
}));
const index = {
  schema: "robobuddy.lab-catalog.v2",
  version: 2,
  freshProgressRequired: true,
  legacyV1ReadOnly: true,
  robots: ROBOT_ORDER.map((id) => ({ id, taskCount: 10 })),
  tasks
};
const migration = { schema: "robobuddy.lab-migration-map.v2", mappings: tasks.map(({ id, supersedes, robotId, rank, migrationClass }) => ({ legacyId: supersedes, successorId: id, robotId, rank, class: migrationClass })) };

const v1Files = (await readdir(resolve(ROOT, "missions", "lab-assistant", "v1"))).filter((name) => name.endsWith(".json")).sort();
if (v1Files.length !== 50) throw new Error(`Expected 50 immutable v1 definitions; found ${v1Files.length}.`);
const legacy = { schema: "robobuddy.legacy-v1-export-manifest.v1", readOnly: true, reinterpretAsV2: false, files: v1Files.map((name) => `missions/lab-assistant/v1/${name}`) };

await writeFile(resolve(V2, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
await writeFile(resolve(V2, "migration-map.json"), `${JSON.stringify(migration, null, 2)}\n`, "utf8");
await writeFile(resolve(V2, "legacy-v1-export.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
await writeFile(METADATA, `${JSON.stringify({ schema: "robobuddy.lab-v2-build.v1", generatedAt: new Date().toISOString(), invocationCount: 1, scenarioCount: definitions.length }, null, 2)}\n`, "utf8");
console.log(`Generated the combined ScenarioV2 catalog exactly once with ${definitions.length} scenarios.`);
