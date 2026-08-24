import fs from "node:fs";
import path from "node:path";

const [portText = "9223", outputDirectory = path.join(process.env.TEMP || process.cwd(), "robobuddy-openarm-table-clearance")] = process.argv.slice(2);
const endpoint = `http://127.0.0.1:${Number(portText)}`;
const targetUrl = `http://127.0.0.1:8765/lab-workbench.html?robot=openarm_v2_bimanual&task=openarm-01-weighing-handoff&table-clearance=${Date.now()}`;
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
  if (message.method === "Runtime.consoleAPICalled") consoleEntries.push({ type: message.params.type, values: message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type) });
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
  return result.result?.value;
}
async function waitFor(expression, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const liveState = await evaluate(`({
    preview: document.querySelector('#labPreviewStatus')?.textContent || '',
    editor: document.querySelector('#labEditorStatus')?.textContent || '',
    pause: document.querySelector('#labPause span')?.textContent || '',
    stopDisabled: document.querySelector('#labStop')?.disabled ?? null,
  })`);
  throw new Error(`Timed out waiting for ${expression}; live state: ${JSON.stringify(liveState)}`);
}

await command("Page.enable");
await command("Runtime.enable");
await command("Network.enable");
await command("Network.setCacheDisabled", { cacheDisabled: true });
await command("Page.navigate", { url: targetUrl });
await waitFor("document.querySelector('#main-content')?.hidden === false && document.querySelector('#labPreviewStatus')?.dataset.tone !== 'error'");
await evaluate("document.querySelector('[data-lab-language=python]').click(); true");
await waitFor("document.querySelector('[data-lab-language=python]')?.getAttribute('aria-selected') === 'true'");
await evaluate("document.querySelector('#labLoadStarter').click(); true");
await waitFor("document.querySelector('#labPythonEditor')?.value.includes('BiOpenArmFollower')");
await evaluate(`(() => {
  window.__tableClearanceCapture = { side: "left", hits: [] };
  const observer = new MutationObserver(() => {
    const capture = window.__tableClearanceCapture;
    const status = document.querySelector('#labPreviewStatus')?.textContent || '';
    const label = capture.side === "left" ? "Watch glass" : "Spatula";
    const pause = document.querySelector('#labPause');
    if (status.includes(label + ' attached after live contact') && pause && !pause.disabled && !capture.hits.includes(capture.side)) {
      capture.hits.push(capture.side);
      if (pause.querySelector('span')?.textContent === 'Pause') pause.click();
    }
  });
  observer.observe(document.querySelector('#labPreviewStatus'), { childList: true, characterData: true, subtree: true });
  window.__tableClearanceCapture.observer = observer;
  return true;
})()`);
await evaluate("document.querySelector('#labRun').click(); true");
await waitFor("document.querySelector('#labPause')?.disabled === false", 120000);
fs.mkdirSync(outputDirectory, { recursive: true });
const records = [];
async function capture(name) {
  const view = await evaluate(`(() => { const stage = document.querySelector('#labPreviewStage').getBoundingClientRect(); return { status: document.querySelector('#labPreviewStatus')?.textContent || '', inspection: document.querySelector('#labCameraInspection')?.title || '', x: stage.x, y: stage.y, width: stage.width, height: stage.height }; })()`);
  const screenshot = await command("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: view.x, y: view.y, width: view.width, height: view.height, scale: 1 } });
  const filename = `${name}.png`;
  fs.writeFileSync(path.join(outputDirectory, filename), Buffer.from(screenshot.data, "base64"));
  records.push({ filename, status: view.status, inspection: view.inspection });
}
async function captureContact(side) {
  await evaluate(`window.__tableClearanceCapture.side = '${side}'; true`);
  await waitFor(`window.__tableClearanceCapture.hits.includes('${side}') && document.querySelector('#labPause span')?.textContent === 'Resume'`, 120000);
  await capture(`${side}-contact-authored`);
  for (let view = 1; view <= 5; view += 1) {
    await evaluate("document.querySelector('#labCameraInspection').click(); true");
    await new Promise((resolve) => setTimeout(resolve, 180));
    await capture(`${side}-contact-inspection-${view}`);
  }
  if (side === "left") await evaluate("window.__tableClearanceCapture.side = 'right'; true");
  await evaluate("document.querySelector('#labPause').click(); true");
}
await captureContact("left");
await captureContact("right");
await waitFor("document.querySelector('#labEditorStatus')?.textContent.includes('outcome and evidence assessment passed')", 120000);
await capture("complete-release-retreat");
const browser = await (await fetch(`${endpoint}/json/version`)).json();
const report = { ok: exceptions.length === 0, browser: browser.Browser, targetUrl, outputDirectory, records, consoleEntries, exceptions };
console.log(JSON.stringify(report, null, 2));
socket.close();
await fetch(`${endpoint}/json/close/${target.id}`);
if (!report.ok) process.exitCode = 1;
