export const PYTHON_RPC_PROTOCOL = "robobuddy.pyodide-rpc.v2";

function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class PythonRpcClient {
  constructor(options = {}) {
    this.workerUrl = options.workerUrl || "js/python-worker.js?v=20260823-portable-python-v1";
    this.workerFactory = options.workerFactory || ((url) => new Worker(url));
    this.apiHandler = options.apiHandler || (async () => { throw rpcError("API_HANDLER_MISSING", "No v2 API handler is configured."); });
    this.defaultTimeoutMs = Number(options.timeoutMs || 15000);
    this.cancelGraceMs = Math.max(0, Number(options.cancelGraceMs ?? 120));
    this.runCounter = 0;
    this.active = null;
    this.ready = false;
    this.createWorker();
  }

  createWorker() {
    this.worker = this.workerFactory(this.workerUrl);
    this.worker.addEventListener("message", (event) => this.onMessage(event.data || {}));
    this.worker.addEventListener("error", (event) => this.failActive("PYTHON_WORKER_ERROR", event.message || "Python worker failed."));
  }

  onMessage(message) {
    if (message.type === "status") { this.ready = message.phase === "ready"; return; }
    if (message.protocol && message.protocol !== PYTHON_RPC_PROTOCOL) return;
    if (message.type === "API_CALL") { void this.handleApiCall(message); return; }
    if (!this.active || message.runId !== this.active.runId) return;
    if (message.type === "RESULT") {
      const active = this.active;
      this.clearActive();
      if (message.ok) active.resolve(message);
      else active.reject(rpcError(message.code || "PYTHON_ERROR", message.error || "Python execution failed."));
    } else if (message.type === "STOPPED") {
      const active = this.active;
      this.clearActive();
      active.reject(rpcError("STOPPED", message.reason || "Python execution stopped."));
    }
  }

  async handleApiCall(message) {
    const active = this.active;
    if (!active || message.runId !== active.runId || !message.callId || active.closed) {
      this.worker.postMessage({ protocol: PYTHON_RPC_PROTOCOL, type: "API_ERROR", runId: message.runId, callId: message.callId, code: "STALE_CALL", error: "Stale or mismatched API call rejected." });
      return;
    }
    if (active.callIds.has(message.callId)) {
      this.worker.postMessage({ protocol: PYTHON_RPC_PROTOCOL, type: "API_ERROR", runId: message.runId, callId: message.callId, code: "DUPLICATE_CALL", error: "Duplicate API call id rejected." });
      return;
    }
    active.callIds.add(message.callId);
    try {
      const response = await this.apiHandler(message.method, message.args || {}, { runId: message.runId, callId: message.callId });
      if (!this.active || this.active.runId !== message.runId || this.active.closed) return;
      this.worker.postMessage({ protocol: PYTHON_RPC_PROTOCOL, type: "API_RESULT", runId: message.runId, callId: message.callId, result: response });
    } catch (error) {
      if (!this.active || this.active.runId !== message.runId || this.active.closed) return;
      this.worker.postMessage({ protocol: PYTHON_RPC_PROTOCOL, type: "API_ERROR", runId: message.runId, callId: message.callId, code: error.code || "API_ERROR", error: error.message || String(error) });
    }
  }

  run(python, options = {}) {
    if (this.active) return Promise.reject(rpcError("RUN_ACTIVE", "Python is already running."));
    const runId = `run-${Date.now()}-${++this.runCounter}`;
    const timeoutMs = Math.max(100, Number(options.timeoutMs || this.defaultTimeoutMs));
    return new Promise((resolve, reject) => {
      this.active = { runId, resolve, reject, timer: null, timeoutMs, remainingMs: timeoutMs, deadlineMs: 0, paused: false, callIds: new Set(), closed: false };
      this.scheduleActiveTimeout(timeoutMs);
      this.worker.postMessage({
        protocol: PYTHON_RPC_PROTOCOL,
        type: "RUN",
        runId,
        python: String(python || ""),
        apiLevel: options.apiLevel || "guided",
        robotId: String(options.robotId || ""),
        profileFiles: options.profileFiles && typeof options.profileFiles === "object" ? options.profileFiles : {}
      });
    });
  }

  pause() {
    if (!this.active) return false;
    if (!this.active.paused) {
      this.active.remainingMs = Math.max(100, this.active.deadlineMs - Date.now());
      clearTimeout(this.active.timer);
      this.active.timer = null;
      this.active.paused = true;
    }
    this.worker.postMessage({ protocol: PYTHON_RPC_PROTOCOL, type: "PAUSE", runId: this.active.runId });
    return true;
  }

  resume() {
    if (!this.active) return false;
    if (this.active.paused) {
      this.active.paused = false;
      this.scheduleActiveTimeout(this.active.remainingMs);
    }
    this.worker.postMessage({ protocol: PYTHON_RPC_PROTOCOL, type: "RESUME", runId: this.active.runId });
    return true;
  }

  scheduleActiveTimeout(durationMs) {
    const active = this.active;
    if (!active) return;
    const duration = Math.max(100, Number(durationMs) || active.timeoutMs);
    active.remainingMs = duration;
    active.deadlineMs = Date.now() + duration;
    clearTimeout(active.timer);
    active.timer = setTimeout(() => {
      if (!this.active || this.active.runId !== active.runId || this.active.paused) return;
      this.worker.postMessage({ protocol: PYTHON_RPC_PROTOCOL, type: "CANCEL", runId: active.runId, reason: "timeout" });
      this.clearActive();
      this.worker.terminate();
      this.ready = false;
      this.createWorker();
      active.reject(rpcError("PYTHON_TIMEOUT", `Python timed out after ${active.timeoutMs} ms.`));
    }, duration);
  }

  cancel(reason = "user") {
    if (!this.active) return false;
    const runId = this.active.runId;
    this.worker.postMessage({ protocol: PYTHON_RPC_PROTOCOL, type: "CANCEL", runId, reason });
    setTimeout(() => {
      if (!this.active || this.active.runId !== runId) return;
      const active = this.active;
      this.clearActive();
      this.worker.terminate();
      this.ready = false;
      this.createWorker();
      active.reject(rpcError("STOPPED", String(reason || "user")));
    }, this.cancelGraceMs);
    return true;
  }

  failActive(code, message) {
    if (!this.active) return;
    const active = this.active;
    this.clearActive();
    active.reject(rpcError(code, message));
  }

  clearActive() {
    if (!this.active) return;
    clearTimeout(this.active.timer);
    this.active.closed = true;
    this.active = null;
  }

  dispose() {
    if (this.active) this.cancel("dispose");
    this.clearActive();
    this.worker?.terminate();
    this.worker = null;
  }
}
