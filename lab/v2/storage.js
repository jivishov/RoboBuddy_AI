const V2_PREFIX = "robobuddy:lab:v2:";
const V1_DRAFT_PREFIX = "robobuddy:lab-draft:v1:";
const V1_PROGRESS_PREFIXES = ["robobuddy:lab-progress:v1:", "robobuddy:lab-state:v1:"];

function storageOrNull(storage) {
  try { return storage || window.localStorage; } catch (error) { return null; }
}

export function v2DraftKey(taskId, language) {
  return `${V2_PREFIX}draft:${taskId}:${language}`;
}

export function v2ProgressKey(taskId) {
  return `${V2_PREFIX}progress:${taskId}`;
}

export function loadV2Draft(taskId, language, fallback = "", storage) {
  const target = storageOrNull(storage);
  if (!target) return fallback;
  return target.getItem(v2DraftKey(taskId, language)) ?? fallback;
}

export function saveV2Draft(taskId, language, value, storage) {
  const target = storageOrNull(storage);
  if (!target) return false;
  target.setItem(v2DraftKey(taskId, language), String(value || ""));
  return true;
}

export function loadV2Progress(taskId, storage) {
  const target = storageOrNull(storage);
  if (!target) return null;
  const value = target.getItem(v2ProgressKey(taskId));
  if (!value) return null;
  try { return JSON.parse(value); } catch (error) { return null; }
}

export function saveV2Progress(taskId, progress, storage) {
  const target = storageOrNull(storage);
  if (!target) return false;
  target.setItem(v2ProgressKey(taskId), JSON.stringify(progress));
  return true;
}

export function resetV2Progress(taskId, storage) {
  const target = storageOrNull(storage);
  if (!target) return false;
  target.removeItem(v2ProgressKey(taskId));
  return true;
}

export function readLegacyV1Archive(storage) {
  const target = storageOrNull(storage);
  if (!target) return { schema: "robobuddy.legacy-v1-browser-export.v1", readOnly: true, entries: [] };
  const entries = [];
  for (let index = 0; index < target.length; index += 1) {
    const key = target.key(index);
    if (!key || !(key.startsWith(V1_DRAFT_PREFIX) || V1_PROGRESS_PREFIXES.some((prefix) => key.startsWith(prefix)))) continue;
    entries.push({ key, value: target.getItem(key) });
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return { schema: "robobuddy.legacy-v1-browser-export.v1", readOnly: true, exportedAt: new Date().toISOString(), entries };
}

export function exportLegacyV1Archive(storage) {
  return JSON.stringify(readLegacyV1Archive(storage), null, 2);
}

export function assertSeparateV2Storage(storage) {
  const target = storageOrNull(storage);
  if (!target) return { ok: true, checked: 0 };
  let checked = 0;
  for (let index = 0; index < target.length; index += 1) {
    const key = target.key(index);
    if (!key) continue;
    if (key.startsWith(V2_PREFIX)) {
      checked += 1;
      if (key.includes(":v1:")) return { ok: false, checked, key };
    }
  }
  return { ok: true, checked };
}
