import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourceFlag = process.argv.indexOf("--source");
if (sourceFlag < 0 || !process.argv[sourceFlag + 1]) {
  throw new Error("Usage: node scripts/verify-lab-source-ledger.mjs --source <Lab Studio techniques directory>");
}

const repoRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(process.argv[sourceFlag + 1]);
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const ledger = await readJson(resolve(repoRoot, "missions", "lab-assistant", "source-ledger.json"));
const catalog = await readJson(resolve(repoRoot, "missions", "lab-assistant", "index.json"));
const sourceActions = new Map();

for (const technique of ledger.techniques) {
  const source = await readJson(resolve(sourceRoot, `${technique.id}.json`));
  assert.equal(source.id, technique.id, `${technique.id} source ID must match the ledger`);
  assert.equal(source.title, technique.title, `${technique.id} source title must match the ledger`);
  const ids = new Set((source.actions || []).map((action) => action.id));
  assert.ok(ids.size > 0, `${technique.id} source must expose action IDs`);
  technique.reviewedActionIds.forEach((actionId) => {
    assert.ok(ids.has(actionId), `${technique.id} ledger action is absent from the authoritative technique: ${actionId}`);
  });
  sourceActions.set(technique.id, ids);
}

for (const task of catalog.tasks) {
  const definition = await readJson(resolve(repoRoot, task.definition));
  for (const ref of definition.techniqueRefs) {
    const authoritativeIds = sourceActions.get(ref.techniqueId);
    assert.ok(authoritativeIds, `${task.id} references an unreviewed technique: ${ref.techniqueId}`);
    assert.ok(ref.actionIds.length > 0, `${task.id}/${ref.techniqueId} must cite at least one action`);
    ref.actionIds.forEach((actionId) => {
      assert.ok(authoritativeIds.has(actionId), `${task.id}/${ref.techniqueId} cites an absent action: ${actionId}`);
    });
  }
}

console.log("Lab source-ledger verification passed:");
console.log(`- ${ledger.techniques.length} technique ledgers match authoritative action IDs`);
console.log(`- ${catalog.tasks.length} scenario definitions cite only verified technique actions`);
console.log("- no source paths, hashes, or source file payloads were added to client-visible scenario data");
