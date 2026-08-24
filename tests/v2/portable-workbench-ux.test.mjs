import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const html = await readFile(resolve(root, "lab-workbench.html"), "utf8");
const source = await readFile(resolve(root, "lab/js/workbench-v2.js"), "utf8");
const pythonRpc = await readFile(resolve(root, "lab/v2/python-rpc.js"), "utf8");
const css = await readFile(resolve(root, "lab/css/styles.css"), "utf8");

assert.equal((html.match(/id="labEmergencyStop"/g) || []).length, 1, "one global emergency STOP control");
assert.doesNotMatch(html, /labStageStop|Simulation Stop<\/span>/, "duplicate stage STOP removed");
assert.match(html, /id="labExportPython"[^>]*>.*Export \.py/s, "portable source export is visible");
assert.match(html, /id="labEditorNote"/, "editor/runtime description is addressable");
assert.match(html, /aria-describedby="labEditorNote labEditorStatus"/, "editor has instructions and live status");
assert.match(html, /aria-expanded="false" aria-controls="labLimitationsBody"/, "long limitations start collapsed");
assert.match(html, /aria-expanded="false" aria-controls="labCommandPanel"/, "command trace uses progressive disclosure");
assert.match(html, /id="labCommandLog" hidden/, "collapsed trace is not an undiscoverable nested viewport");

assert.doesNotMatch(source.match(/function populateTaskSelector\(\)[\s\S]*?\n\}/)?.[0] || "", /catalog\.robots\.map/, "task selector is scoped to the current robot");
assert.match(source, /function predicateLabel/, "internal predicate names are translated for learners");
assert.match(source, /index === activeIndex \? "active" : "pending"/, "only one pending checkpoint is current");
assert.match(source, /const fault = app\.engine\?\.plant\?\.fault/, "authoritative plant fault leads status rendering");
assert.match(source, /Collision fault/, "stage exposes a distinct collision state");
assert.match(source, /Reset Task, inspect the route and contact pose, then retry/, "collision recovery is actionable");
assert.match(source, /ArrowRight.*ArrowDown/s, "language tabs support arrow-key navigation");
assert.match(source, /event\.key === "Enter"/, "Ctrl+Enter run shortcut is implemented");
assert.match(source, /function exportPython/, "source export is implemented");
assert.match(source, /document\.body\.append\(link\);[\s\S]*?link\.click\(\);[\s\S]*?setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 1000\)/, "source export retains its blob URL until the browser accepts the download");
assert.match(source, /const paused = app\.paused \|\| state\.runState === "paused";/, "3D status uses the authoritative paused plant state as well as the UI controller state");
assert.match(source, /syncInspectionCameraButton\(\);\s*renderState\(state\);/, "changing an inspection camera cannot leave the 3D status strip stale");
assert.match(source, /timeoutMs:\s*portable\s*\?\s*240000\s*:\s*60000/, "complete portable physical scripts retain a bounded four-minute execution budget");
assert.match(pythonRpc, /remainingMs[\s\S]*deadlineMs[\s\S]*paused/, "Python pause/resume preserves rather than consumes the remaining execution budget");

assert.match(css, /#labPythonEditor:focus-visible/, "code editor has a visible keyboard focus treatment");
assert.match(css, /@media \(max-width: 1420px\) and \(min-width: 1201px\)/, "15-inch laptop reflow begins before columns become cramped");
assert.match(css, /\.lab-button,\s*\n\.lab-icon-button \{[\s\S]*?min-height: 40px/, "frequent desktop controls meet the bounded target size");
assert.match(css, /\.lab-camera-controls \.lab-icon-button \{[\s\S]*?width: 40px;[\s\S]*?min-height: 40px/, "camera controls remain operable at laptop size");
assert.match(css, /prefers-reduced-motion: reduce/, "reduced-motion override remains present");

console.log("portable workbench UX/static contract: PASS");
console.log("- one STOP, scoped tasks, human checkpoints, truthful fault recovery, source export");
console.log("- keyboard tabs/shortcuts, editor focus, progressive disclosure, laptop reflow, reduced motion");
