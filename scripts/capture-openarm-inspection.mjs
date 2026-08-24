import fs from "node:fs";
import path from "node:path";

const [portText = "9223", outputDirectory = path.join(process.env.TEMP || process.cwd(), "robobuddy-openarm-inspection")] = process.argv.slice(2);
const endpoint = `http://127.0.0.1:${Number(portText)}`;
const targetUrl = `http://127.0.0.1:8765/lab-workbench.html?robot=openarm_v2_bimanual&task=openarm-01-weighing-handoff&inspection=${Date.now()}`;
const response = await fetch(`${endpoint}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
if (!response.ok) throw new Error(`Unable to create browser target: HTTP ${response.status}`);
const target = await response.json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let counter = 0;
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open.")), { once: true });
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.error) item.reject(new Error(message.error.message));
  else item.resolve(message.result || {});
});
function command(method, params = {}) {
  const id = ++counter;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await command("Page.enable");
await command("Runtime.enable");
await command("Network.enable");
await command("Network.setCacheDisabled", { cacheDisabled: true });
await command("Page.navigate", { url: targetUrl });
const started = Date.now();
while (Date.now() - started < 60000) {
  const ready = await command("Runtime.evaluate", { expression: "document.querySelector('#main-content')?.hidden === false && document.querySelector('#labPreviewStatus')?.dataset.tone !== 'error'", returnByValue: true });
  if (ready.result?.value === true) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

fs.mkdirSync(outputDirectory, { recursive: true });
const records = [];
for (let index = 0; index < 5; index += 1) {
  const evaluated = await command("Runtime.evaluate", {
    expression: `(() => {
      document.querySelector('#labCameraInspection').click();
      const stage = document.querySelector('#labPreviewStage').getBoundingClientRect();
      return { label: document.querySelector('#labAnnouncer')?.textContent || document.querySelector('#labCameraInspection')?.title || '', x: stage.x, y: stage.y, width: stage.width, height: stage.height };
    })()`,
    returnByValue: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const view = evaluated.result.value;
  const screenshot = await command("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: view.x, y: view.y, width: view.width, height: view.height, scale: 1 } });
  const filename = `openarm-inspection-${index + 1}.png`;
  fs.writeFileSync(path.join(outputDirectory, filename), Buffer.from(screenshot.data, "base64"));
  records.push({ filename, label: view.label });
}
console.log(JSON.stringify({ outputDirectory, records }, null, 2));
socket.close();
await fetch(`${endpoint}/json/close/${target.id}`);
