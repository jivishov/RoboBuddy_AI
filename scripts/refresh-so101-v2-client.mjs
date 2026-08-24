import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertScenarioV2, stripValidationForClient } from "../lab/v2/scenario-schema.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "missions", "lab-assistant", "v2", "definitions", "so101");
const OUTPUT = resolve(ROOT, "missions", "lab-assistant", "v2", "generated", "scenarios");

const files = (await readdir(SOURCE)).filter((name) => name.endsWith(".json")).sort();
if (files.length !== 10) throw new Error(`Expected 10 SO-101 definitions; found ${files.length}.`);

for (const name of files) {
  const definition = JSON.parse(await readFile(resolve(SOURCE, name), "utf8"));
  assertScenarioV2(definition, { expectedRobotId: "so101_follower" });
  await writeFile(resolve(OUTPUT, name), `${JSON.stringify(stripValidationForClient(definition), null, 2)}\n`, "utf8");
}

console.log("Refreshed 10 SO-101 browser scenarios without rebuilding the combined catalog or any other robot family.");
