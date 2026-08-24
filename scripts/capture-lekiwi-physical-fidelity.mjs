import fs from "node:fs";
import path from "node:path";

const [portText = "9224", outputDirectory = path.join(process.env.TEMP || process.cwd(), "robobuddy-lekiwi-physical-fidelity")] = process.argv.slice(2);
const endpoint = `http://127.0.0.1:${Number(portText)}`;
const targetUrl = `http://127.0.0.1:8765/lab-workbench.html?robot=lekiwi_sim&task=lekiwi-09-titration-logistics&language=python&lekiwi-fidelity=${Date.now()}`;
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed.");
  return result.result?.value;
}
async function waitFor(expression, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const state = await evaluate(`({
    preview: document.querySelector('#labPreviewStatus')?.textContent || '',
    editor: document.querySelector('#labEditorStatus')?.textContent || '',
    phase: window.__lekiwiCapture?.phase || '',
    hits: window.__lekiwiCapture?.hits || [],
  })`);
  throw new Error(`Timed out waiting for ${expression}; state=${JSON.stringify(state)}`);
}

await command("Page.enable");
await command("Runtime.enable");
await command("Network.enable");
await command("Network.setCacheDisabled", { cacheDisabled: true });
await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await command("Page.navigate", { url: targetUrl });
await waitFor("document.querySelector('#main-content')?.hidden === false && document.querySelector('#labPreviewStatus')?.dataset.tone !== 'error'", 90000);
await evaluate("document.querySelector('[data-lab-language=python]').click(); true");
await waitFor("document.querySelector('[data-lab-language=python]')?.getAttribute('aria-selected') === 'true'");
await evaluate("document.querySelector('#labLoadStarter').click(); true");
const starter = await waitFor(`(() => {
  const source = document.querySelector('#labPythonEditor')?.value || '';
  return source.includes('from lerobot.robots.lekiwi import LeKiwiClient, LeKiwiClientConfig')
    && source.includes('LeKiwiClient(LeKiwiClientConfig')
    && source.includes('robot.send_action') ? source : '';
})()`);
if (/skills\.|transport\s*\(/.test(starter)) throw new Error("LeKiwi starter exposed a non-official skills helper.");

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
  records.push({ filename, status: view.status, editor: view.editor, inspection: view.inspection, viewport: view.viewport });
}
async function captureInspectionSet(prefix, count = 4) {
  for (let index = 1; index <= count; index += 1) {
    await evaluate("document.querySelector('#labCameraInspection').click(); true");
    await new Promise((resolve) => setTimeout(resolve, 220));
    await capture(`${prefix}-view-${index}`);
  }
}
async function dragStage(button, dx, dy) {
  const stage = await evaluate(`(() => {
    const rect = document.querySelector('#labPreviewStage').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  const buttons = button === "right" ? 2 : 1;
  await command("Input.dispatchMouseEvent", { type: "mousePressed", x: stage.x, y: stage.y, button, buttons, clickCount: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: stage.x + dx, y: stage.y + dy, button, buttons });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: stage.x + dx, y: stage.y + dy, button, buttons: 0, clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 260));
}
async function captureOrbitSet(prefix) {
  const movements = [[75, 0], [-150, 0], [75, -55], [0, 110], [0, -55]];
  for (let index = 0; index < movements.length; index += 1) {
    await dragStage("left", ...movements[index]);
    await capture(`${prefix}-view-${index + 1}`);
  }
}

await capture("1440x900-initial-full", true);
await captureInspectionSet("1440x900-initial", 3);
await evaluate(`(() => {
  window.__lekiwiCapture = { phase: 'contact', hits: [], history: [] };
  const observer = new MutationObserver(() => {
    const capture = window.__lekiwiCapture;
    const status = document.querySelector('#labPreviewStatus')?.textContent || '';
    if (capture.history.at(-1) !== status) capture.history.push(status);
    const pause = document.querySelector('#labPause');
    if (!pause || pause.disabled || pause.querySelector('span')?.textContent !== 'Pause') return;
    if (capture.phase === 'contact' && status.includes('attached after live contact')) {
      capture.hits.push('contact');
      capture.phase = 'contact_paused';
      pause.click();
    } else if (capture.phase === 'release' && status.includes('No object attached')) {
      capture.hits.push('release');
      capture.phase = 'release_paused';
      pause.click();
    }
  });
  observer.observe(document.querySelector('#labPreviewStatus'), { childList: true, characterData: true, subtree: true });
  window.__lekiwiCapture.observer = observer;
  return true;
})()`);
await evaluate("document.querySelector('#labRun').click(); true");
await waitFor("window.__lekiwiCapture?.hits.includes('contact') && document.querySelector('#labPause span')?.textContent === 'Resume'", 240000);
// LeKiwi is mobile, so center the live workcell with trusted OrbitControls pan
// gestures before inspecting. This changes only the camera, never scenario or
// robot state, and deliberately exposes the contact instead of concealing it.
await dragStage("right", -350, 0);
await dragStage("right", -350, 0);
await dragStage("right", 0, 220);
await capture("1440x900-contact-full", true);
await captureOrbitSet("1440x900-contact");
await evaluate("window.__lekiwiCapture.phase = 'release'; document.querySelector('#labPause').click(); true");
await waitFor("window.__lekiwiCapture?.hits.includes('release') && document.querySelector('#labPause span')?.textContent === 'Resume'", 180000);
await capture("1440x900-release-full", true);
await captureOrbitSet("1440x900-release");
await evaluate("window.__lekiwiCapture.phase = 'complete'; document.querySelector('#labPause').click(); true");
await waitFor("document.querySelector('#labEditorStatus')?.textContent.includes('outcome and evidence assessment passed')", 180000);
await capture("1440x900-complete-full", true);
await captureInspectionSet("1440x900-complete", 3);

await command("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
await new Promise((resolve) => setTimeout(resolve, 400));
await capture("1366x768-complete-full", true);
await captureInspectionSet("1366x768-complete", 3);

const browser = await (await fetch(`${endpoint}/json/version`)).json();
const history = await evaluate("window.__lekiwiCapture.history");
const report = {
  ok: exceptions.length === 0,
  browser: browser.Browser,
  targetUrl,
  outputDirectory,
  officialStarter: {
    import: "lerobot.robots.lekiwi.LeKiwiClient/LeKiwiClientConfig",
    sendAction: starter.includes("robot.send_action"),
    skillsHelperAbsent: !/skills\.|transport\s*\(/.test(starter),
  },
  history,
  records,
  consoleEntries,
  exceptions,
};
console.log(JSON.stringify(report, null, 2));
socket.close();
await fetch(`${endpoint}/json/close/${target.id}`);
if (!report.ok) process.exitCode = 1;
