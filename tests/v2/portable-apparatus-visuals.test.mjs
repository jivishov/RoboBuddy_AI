import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripValidationForClient } from "../../lab/v2/scenario-schema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const definitionRoot = path.join(root, "missions/lab-assistant/v2/definitions");
const generatedRoot = path.join(root, "missions/lab-assistant/v2/generated/scenarios");
const rendererSource = fs.readFileSync(path.join(root, "lab/js/objects.js"), "utf8");
const families = ["so101", "lekiwi", "openarm"];
const definitions = families.flatMap((family) => fs.readdirSync(path.join(definitionRoot, family))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({
    family,
    name,
    definition: JSON.parse(fs.readFileSync(path.join(definitionRoot, family, name), "utf8")),
  })));

assert.equal(definitions.length, 30);
const objects = definitions.flatMap(({ definition }) => definition.objects
  .filter((item) => item.transportable !== false)
  .map((item) => ({ definition, item })));
assert.equal(objects.length, 45);

const expected = new Map([
  ["openarm-01-weighing-handoff/left_watch_glass", "watch_glass"],
  ["openarm-01-weighing-handoff/right_bottle", "bottle"],
  ["openarm-03-cuvette-handoff/left_cuvette", "cuvette"],
  ["openarm-04-filtration-workcell/left_filter_flask", "filter_flask"],
  ["openarm-04-filtration-workcell/right_bottle", "bottle"],
  ["openarm-05-titration-workcell/left_flask", "flask"],
  ["so101-v2-05-pipette-pump/pipette_pump", "pipette_pump"],
  ["so101-v2-08-burette-initial-reading/titrant_bottle", "bottle"],
  ["so101-v2-09-vacuum-filtration/filtration_beaker", "beaker"],
  ["lekiwi-02-glassware-route/sealed_glassware_carrier", "flask"],
  ["lekiwi-07-chromatography-route/sealed_chromatography_supply_bin", "bottle"],
]);

const apparatusTypes = new Set();
for (const { definition, item } of objects) {
  const key = `${definition.id}/${item.id}`;
  assert.equal(item.visual?.directHandling, true, `${key}: gripper must contact the intended apparatus directly`);
  assert.equal(item.visual?.containerFree, true, `${key}: transport containers are forbidden`);
  assert.notEqual(item.visual?.type, "apparatus_transport", `${key}: transport composite is forbidden`);
  assert.notEqual(item.visual?.type, "secured_carrier", `${key}: generic carrier cannot replace intended equipment`);
  assert.notEqual(item.visual?.type, "configured_object", `${key}: generic fallback cannot replace intended equipment`);
  assert.ok(Number(item.visual?.heightMm) >= 5, `${key}: visible apparatus must have a configured physical height`);
  assert.equal(item.physicalRest.geometry.halfExtentsMm[1] * 2, item.visual.heightMm, `${key}: collision/rest proxy must enclose the rendered apparatus height`);
  apparatusTypes.add(item.visual.type);
  if (expected.has(key)) assert.equal(item.visual.type, expected.get(key), `${key}: task-specific apparatus mapping`);

}
assert.ok(apparatusTypes.size >= 7, `portable catalog should render diverse genuine equipment, found only ${[...apparatusTypes].join(", ")}`);
assert.match(rendererSource, /function createApparatusVisual\(definition\)/, "renderer needs a direct genuine-apparatus factory");
assert.match(rendererSource, /definition\.visual\?\.directHandling === true/, "renderer must retain the direct-handling contract");
for (const type of apparatusTypes) {
  assert.match(rendererSource, new RegExp(`case ["']${type}["']:`), `renderer factory for ${type}`);
}

for (const { name, definition } of definitions) {
  const generated = JSON.parse(fs.readFileSync(path.join(generatedRoot, name), "utf8"));
  assert.deepEqual(generated, stripValidationForClient(definition), `${definition.id}: source/generated apparatus parity`);
}

console.log(`portable apparatus visual regression: PASS (${objects.length} directly handled payloads, ${apparatusTypes.size} apparatus families, no transport composites or generic fallback boxes)`);
