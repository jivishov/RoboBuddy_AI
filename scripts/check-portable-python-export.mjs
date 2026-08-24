import fs from "node:fs";
import path from "node:path";

const [
  portText = "9223",
  outputDirectory = path.join(process.env.TEMP || process.cwd(), "robobuddy-portable-export"),
] = process.argv.slice(2);
const endpoint = `http://127.0.0.1:${Number(portText)}`;
const targetUrl = `http://127.0.0.1:8765/lab-workbench.html?robot=openarm_v2_bimanual&task=openarm-01-weighing-handoff&language=python&export-audit=${Date.now()}`;
fs.mkdirSync(outputDirectory, { recursive: true });

const response = await fetch(`${endpoint}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
if (!response.ok) throw new Error(`Unable to create browser target: HTTP ${response.status}`);
const target = await response.json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const downloads = new Map();
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
  if (message.method === "Browser.downloadWillBegin") {
    downloads.set(message.params.guid, { ...message.params, state: "inProgress" });
  } else if (message.method === "Browser.downloadProgress") {
    const record = downloads.get(message.params.guid) || { guid: message.params.guid };
    Object.assign(record, message.params);
    downloads.set(message.params.guid, record);
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
await command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path.resolve(outputDirectory), eventsEnabled: true });
await command("Page.navigate", { url: targetUrl });
const started = Date.now();
while (Date.now() - started < 60000) {
  if (await evaluate("document.querySelector('#main-content')?.hidden === false")) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
await evaluate("document.querySelector('#labLoadStarter').click(); true");
await evaluate("document.querySelector('#labExportPython').click(); true");
const downloadStarted = Date.now();
while (Date.now() - downloadStarted < 10000) {
  if ([...downloads.values()].some((item) => item.state === "completed")) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const record = [...downloads.values()][0] || null;
const expectedName = "openarm-01-weighing-handoff.py";
const expectedPath = path.resolve(outputDirectory, expectedName);
const source = fs.existsSync(expectedPath) ? fs.readFileSync(expectedPath, "utf8") : "";
const browser = await (await fetch(`${endpoint}/json/version`)).json();
const report = {
  ok: record?.state === "completed" && record.suggestedFilename === expectedName && source.includes("BiOpenArmFollower") && exceptions.length === 0,
  browser: browser.Browser,
  targetUrl,
  expectedPath,
  bytes: Buffer.byteLength(source),
  firstLine: source.split("\n")[0] || "",
  download: record,
  status: await evaluate("document.querySelector('#labEditorStatus')?.textContent || ''"),
  exceptions: exceptions.map((entry) => ({ text: entry.text, description: entry.exception?.description || "" })),
};
console.log(JSON.stringify(report, null, 2));
socket.close();
await fetch(`${endpoint}/json/close/${target.id}`);
if (!report.ok) process.exitCode = 1;
