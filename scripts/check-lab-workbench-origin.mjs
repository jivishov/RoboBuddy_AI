const [portText = "9223", targetUrl = "http://127.0.0.1:8765/lab-workbench.html?robot=openarm_v2_bimanual&task=openarm-01-weighing-handoff", timeoutText = "60000"] = process.argv.slice(2);
const port = Number(portText);
const timeoutMs = Number(timeoutText);
const endpoint = `http://127.0.0.1:${port}`;

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

await command("Runtime.enable");
await command("Page.enable");
await command("Network.enable");
await command("Network.setCacheDisabled", { cacheDisabled: true });
await command("Page.navigate", { url: targetUrl });

const startedAt = Date.now();
let state = {};
while (Date.now() - startedAt < timeoutMs) {
  const evaluated = await command("Runtime.evaluate", {
    expression: `({
      loadingHidden: document.querySelector('#labWorkbenchLoading')?.hidden === true,
      shellVisible: document.querySelector('#main-content')?.hidden === false,
      errorVisible: document.querySelector('#labWorkbenchError')?.hidden === false,
      errorText: document.querySelector('#labWorkbenchError p')?.textContent || '',
      title: document.querySelector('#labWorkbenchTitle')?.textContent || '',
      editorPrefix: document.querySelector('#labPythonEditor')?.value?.slice(0, 120) || '',
      previewStatus: document.querySelector('#labPreviewStatus')?.textContent || ''
    })`,
    returnByValue: true,
  });
  state = evaluated.result?.value || {};
  if (state.loadingHidden && (state.shellVisible || state.errorVisible)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const browserVersion = await (await fetch(`${endpoint}/json/version`)).json();
const report = {
  ok: state.shellVisible === true && state.errorVisible === false && exceptions.length === 0,
  browser: browserVersion.Browser,
  targetUrl,
  elapsedMs: Date.now() - startedAt,
  state,
  consoleEntries,
  exceptions: exceptions.map((entry) => ({ text: entry.text, description: entry.exception?.description || "" })),
};

console.log(JSON.stringify(report, null, 2));
socket.close();
await fetch(`${endpoint}/json/close/${target.id}`);
if (!report.ok) process.exitCode = 1;
