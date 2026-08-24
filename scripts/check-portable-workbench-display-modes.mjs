import fs from "node:fs";
import path from "node:path";

const [
  portText = "9223",
  outputDirectory = path.join(process.env.TEMP || process.cwd(), "robobuddy-portable-display-modes"),
] = process.argv.slice(2);
const endpoint = `http://127.0.0.1:${Number(portText)}`;
const targetUrl = `http://127.0.0.1:8765/lab-workbench.html?robot=openarm_v2_bimanual&task=openarm-01-weighing-handoff&language=python&display-audit=${Date.now()}`;
const response = await fetch(`${endpoint}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
if (!response.ok) throw new Error(`Unable to create browser target: HTTP ${response.status}`);
const target = await response.json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
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
  } else if (message.method === "Runtime.exceptionThrown") {
    exceptions.push(message.params.exceptionDetails);
  }
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

await command("Page.enable");
await command("Runtime.enable");
await command("Network.enable");
await command("Network.setCacheDisabled", { cacheDisabled: true });
// A 720 x 450 CSS viewport at DPR 2 exercises the same reflow pressure as a
// 1440 x 900 laptop at 200% browser zoom while retaining a 1440 x 900 raster.
await command("Emulation.setDeviceMetricsOverride", {
  width: 720,
  height: 450,
  deviceScaleFactor: 2,
  mobile: false,
  screenWidth: 1440,
  screenHeight: 900,
});
await command("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
await command("Page.navigate", { url: targetUrl });

const started = Date.now();
while (Date.now() - started < 60000) {
  if (await evaluate("document.querySelector('#main-content')?.hidden === false")) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const state = await evaluate(`(() => {
  const visibleControls = [...document.querySelectorAll('button:not([hidden]), a[href]:not([hidden]), select:not([hidden])')]
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.id, label: element.getAttribute('aria-label') || element.textContent.trim(), width: rect.width, height: rect.height };
    })
    .filter((item) => item.width > 0 && item.height > 0);
  const preview = document.querySelector('#labPreviewStage');
  const procedureScroll = document.querySelector('.lab-procedure-scroll');
  const editor = document.querySelector('.lab-editor-panel');
  const reducedProbe = document.querySelector('.lab-button');
  const reducedStyle = reducedProbe ? getComputedStyle(reducedProbe) : null;
  return {
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    reducedTransitionDuration: reducedStyle?.transitionDuration || '',
    preview: preview ? { width: preview.clientWidth, height: preview.clientHeight } : null,
    editor: editor ? { width: editor.clientWidth, height: editor.clientHeight } : null,
    taskScroll: procedureScroll ? { clientHeight: procedureScroll.clientHeight, scrollHeight: procedureScroll.scrollHeight, overflowY: getComputedStyle(procedureScroll).overflowY } : null,
    minimumVisibleControlHeight: Math.min(...visibleControls.map((item) => item.height)),
    undersizedControls: visibleControls.filter((item) => item.height < 44),
    collapsed: {
      limitations: document.querySelector('#labLimitationsBody')?.hidden === true,
      safety: document.querySelector('#labSafetyBody')?.hidden === true,
      trace: document.querySelector('#labCommandLog')?.hidden === true,
    },
    previewStatus: document.querySelector('#labPreviewStatus')?.textContent || '',
  };
})()`);

fs.mkdirSync(outputDirectory, { recursive: true });
const screenshot = await command("Page.captureScreenshot", { format: "png", fromSurface: true });
const screenshotPath = path.join(outputDirectory, "after-edge-200pct-equivalent.png");
fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
const browser = await (await fetch(`${endpoint}/json/version`)).json();
const report = {
  ok: !state.horizontalOverflow && state.reducedMotion && state.undersizedControls.length === 0 && exceptions.length === 0,
  browser: browser.Browser,
  targetUrl,
  screenshotPath,
  state,
  exceptions: exceptions.map((entry) => ({ text: entry.text, description: entry.exception?.description || "" })),
};
console.log(JSON.stringify(report, null, 2));
socket.close();
await fetch(`${endpoint}/json/close/${target.id}`);
if (!report.ok) process.exitCode = 1;
