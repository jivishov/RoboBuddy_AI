import fs from "node:fs";
import path from "node:path";

const [
  portText = "9224",
  outputDirectory = path.join(process.env.TEMP || process.cwd(), "robobuddy-openarm-physical-fidelity"),
  taskId = "openarm-03-cuvette-handoff",
  widthText = "1440",
  heightText = "900",
] = process.argv.slice(2);
const width = Number(widthText);
const height = Number(heightText);
const endpoint = `http://127.0.0.1:${Number(portText)}`;
const targetUrl = `http://127.0.0.1:8765/lab-workbench.html?robot=openarm_v2_bimanual&task=${encodeURIComponent(taskId)}&language=python&physical-fidelity=${Date.now()}`;
const response = await fetch(`${endpoint}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
if (!response.ok) throw new Error(`Unable to create browser target: HTTP ${response.status}`);
const target = await response.json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const consoleEntries = [];
const exceptions = [];
let counter = 0;

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open.")), { once: true });
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result || {});
    return;
  }
  if (message.method === "Runtime.consoleAPICalled") {
    consoleEntries.push({ type: message.params.type, values: message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type) });
  }
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
});

function command(method, params = {}) {
  const id = ++counter;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed.");
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const state = await evaluate(`({
    preview: document.querySelector('#labPreviewStatus')?.textContent || '',
    editor: document.querySelector('#labEditorStatus')?.textContent || '',
    capture: window.__openArmCapture || null,
  })`);
  throw new Error(`Timed out waiting for ${expression}; state=${JSON.stringify(state)}`);
}

await command("Page.enable");
await command("Runtime.enable");
await command("Network.enable");
await command("Network.setCacheDisabled", { cacheDisabled: true });
await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
await command("Page.navigate", { url: targetUrl });
await waitFor("document.querySelector('#main-content')?.hidden === false && document.querySelector('#labPreviewStatus')?.dataset.tone !== 'error'", 90000);
await evaluate("document.querySelector('[data-lab-language=python]').click(); true");
await waitFor("document.querySelector('[data-lab-language=python]')?.getAttribute('aria-selected') === 'true'");
await evaluate("document.querySelector('#labLoadStarter').click(); true");
const starter = await waitFor(`(() => {
  const source = document.querySelector('#labPythonEditor')?.value || '';
  return source.includes('from lerobot.robots.openarm_follower import OpenArmFollowerConfigBase')
    && source.includes('from lerobot.robots.bi_openarm_follower import BiOpenArmFollower, BiOpenArmFollowerConfig')
    && source.includes('robot.send_action') ? source : '';
})()`);
if (/skills\.|transport\s*\(/.test(starter)) throw new Error("OpenArm starter exposed a semantic transport shortcut.");

fs.mkdirSync(outputDirectory, { recursive: true });
const records = [];
async function capture(name, fullViewport = false) {
  const view = await evaluate(`(() => {
    const stage = document.querySelector('#labPreviewStage').getBoundingClientRect();
    return {
      status: document.querySelector('#labPreviewStatus')?.textContent || '',
      editor: document.querySelector('#labEditorStatus')?.textContent || '',
      inspection: document.querySelector('#labCameraInspection')?.title || '',
      stage: { x: stage.x, y: stage.y, width: stage.width, height: stage.height },
      viewport: { width: innerWidth, height: innerHeight },
    };
  })()`);
  const params = { format: "png", fromSurface: true };
  if (!fullViewport) params.clip = { ...view.stage, scale: 1 };
  const screenshot = await command("Page.captureScreenshot", params);
  const filename = `${name}.png`;
  fs.writeFileSync(path.join(outputDirectory, filename), Buffer.from(screenshot.data, "base64"));
  records.push({ filename, ...view });
}

async function captureViews(prefix) {
  await capture(`${prefix}-full`, true);
  for (let index = 1; index <= 5; index += 1) {
    await evaluate("document.querySelector('#labCameraInspection').click(); true");
    await new Promise((resolve) => setTimeout(resolve, 220));
    await capture(`${prefix}-view-${index}`);
  }
}

await captureViews(`${width}x${height}-initial`);
await evaluate(`(() => {
  window.__openArmCapture = {
    phase: 'approach',
    transfer: 1,
    hits: [],
    history: [],
    wasAttached: false,
  };
  const observer = new MutationObserver(() => {
    const capture = window.__openArmCapture;
    const status = document.querySelector('#labPreviewStatus')?.textContent || '';
    if (capture.history.at(-1) !== status) capture.history.push(status);
    const pause = document.querySelector('#labPause');
    const canPause = pause && !pause.disabled && pause.querySelector('span')?.textContent === 'Pause';
    const attached = status.includes('attached after live contact');
    if (attached) capture.wasAttached = true;
    let hit = '';
    if (capture.phase === 'approach' && /approach/i.test(status)) hit = 'approach-' + capture.transfer;
    else if (capture.phase === 'attach' && attached) hit = 'attach-' + capture.transfer;
    else if (capture.phase === 'release' && capture.wasAttached && status.includes('No object attached')) hit = 'release-' + capture.transfer;
    if (!hit || capture.hits.includes(hit) || !canPause) return;
    capture.hits.push(hit);
    capture.phase = 'paused';
    if (hit.startsWith('release')) capture.wasAttached = false;
    pause.click();
  });
  observer.observe(document.querySelector('#labPreviewStatus'), { childList: true, characterData: true, subtree: true });
  window.__openArmCapture.observer = observer;
  return true;
})()`);
await evaluate("document.querySelector('#labRun').click(); true");

async function waitForPausedHit(hit) {
  await waitFor(`window.__openArmCapture?.hits.includes('${hit}') && document.querySelector('#labPause span')?.textContent === 'Resume'`, 240000);
}
async function continueWith(phase, transfer) {
  await evaluate(`window.__openArmCapture.phase = '${phase}'; window.__openArmCapture.transfer = ${transfer}; document.querySelector('#labPause').click(); true`);
}

for (let transfer = 1; transfer <= 2; transfer += 1) {
  await waitForPausedHit(`approach-${transfer}`);
  await captureViews(`${width}x${height}-transfer-${transfer}-approach`);
  await continueWith("attach", transfer);
  await waitForPausedHit(`attach-${transfer}`);
  await captureViews(`${width}x${height}-transfer-${transfer}-attached`);
  await continueWith("release", transfer);
  await waitForPausedHit(`release-${transfer}`);
  await captureViews(`${width}x${height}-transfer-${transfer}-release`);
  if (transfer < 2) await continueWith("approach", transfer + 1);
}

await continueWith("complete", 2);
await waitFor("document.querySelector('#labEditorStatus')?.textContent.includes('outcome and evidence assessment passed')", 240000);
await captureViews(`${width}x${height}-complete-retreat`);

const browser = await (await fetch(`${endpoint}/json/version`)).json();
const captureState = await evaluate(`({
  hits: window.__openArmCapture.hits,
  history: window.__openArmCapture.history,
  preview: document.querySelector('#labPreviewStatus')?.textContent || '',
  editor: document.querySelector('#labEditorStatus')?.textContent || '',
})`);
const expectedHits = ["approach-1", "attach-1", "release-1", "approach-2", "attach-2", "release-2"];
const report = {
  ok: exceptions.length === 0
    && expectedHits.every((hit) => captureState.hits.includes(hit))
    && captureState.editor.includes("outcome and evidence assessment passed"),
  browser: browser.Browser,
  taskId,
  targetUrl,
  outputDirectory,
  viewport: { width, height },
  officialStarter: {
    openArmFollowerConfigBase: starter.includes("OpenArmFollowerConfigBase"),
    biOpenArmFollowerConfig: starter.includes("BiOpenArmFollowerConfig"),
    biOpenArmFollower: starter.includes("BiOpenArmFollower"),
    immediateSendAction: starter.includes("robot.send_action"),
    semanticShortcutAbsent: !/skills\.|transport\s*\(/.test(starter),
  },
  captureState,
  records,
  consoleEntries,
  exceptions,
};
console.log(JSON.stringify(report, null, 2));
socket.close();
await fetch(`${endpoint}/json/close/${target.id}`);
if (!report.ok) process.exitCode = 1;
