const [portText = "9223", targetUrl = "http://127.0.0.1:8765/tests/browser/jspi-origin-prototype.html", timeoutText = "120000"] = process.argv.slice(2);
const port = Number(portText);
const timeoutMs = Number(timeoutText);
const endpoint = `http://127.0.0.1:${port}`;

const targetResponse = await fetch(`${endpoint}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
if (!targetResponse.ok) throw new Error(`Unable to create browser target: HTTP ${targetResponse.status}`);
const target = await targetResponse.json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const consoleEntries = [];
const exceptions = [];
let counter = 0;

const opened = new Promise((resolve, reject) => {
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

await opened;

function command(method, params = {}) {
  const id = ++counter;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await command("Runtime.enable");
await command("Page.enable");
await command("Page.navigate", { url: targetUrl });

const startedAt = Date.now();
let complete = false;
while (Date.now() - startedAt < timeoutMs) {
  const evaluated = await command("Runtime.evaluate", {
    expression: "document.querySelector('#result')?.dataset.complete === 'true'",
    returnByValue: true,
  });
  complete = evaluated.result?.value === true;
  if (complete) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const evaluated = await command("Runtime.evaluate", {
  expression: "({ gate: document.documentElement.dataset.gate || '', report: document.querySelector('#result')?.textContent || '', status: document.querySelector('#status')?.textContent || '' })",
  returnByValue: true,
});
const page = evaluated.result?.value || {};
const browserVersion = await (await fetch(`${endpoint}/json/version`)).json();
const report = {
  ok: complete && page.gate === "pass" && exceptions.length === 0,
  browser: browserVersion.Browser,
  targetUrl,
  complete,
  gate: page.gate,
  status: page.status,
  pageReport: page.report ? JSON.parse(page.report) : null,
  consoleEntries,
  exceptions: exceptions.map((entry) => ({ text: entry.text, description: entry.exception?.description || "" })),
};

console.log(JSON.stringify(report, null, 2));
socket.close();
await fetch(`${endpoint}/json/close/${target.id}`);
if (!report.ok) process.exitCode = 1;
