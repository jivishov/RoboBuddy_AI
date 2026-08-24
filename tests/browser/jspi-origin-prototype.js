const PROTOCOL = "robobuddy.jspi-origin-gate.v1";
const TICK_SECONDS = 0.02;
const JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];
const status = document.getElementById("status");
const resultElement = document.getElementById("result");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const baseline = () => ({
  connected: false,
  target: Object.fromEntries(JOINTS.map((joint) => [`${joint}.pos`, 0])),
  actual: Object.fromEntries(JOINTS.map((joint) => [`${joint}.pos`, 0])),
  mobile: { x: 0, y: 0, theta: 0 },
  clock: 0,
  sleeping: false,
  paused: false,
  stopped: false,
  events: [],
});

class GateController {
  constructor() {
    this.counter = 0;
    this.active = null;
    this.generation = 0;
    this.state = baseline();
    this.createWorker();
  }

  createWorker() {
    this.worker = new Worker("./jspi-origin-worker.js");
    this.worker.addEventListener("message", (event) => this.onMessage(event.data || {}));
    this.worker.addEventListener("error", (event) => this.rejectActive("WORKER_ERROR", event.message || "Worker failed."));
    this.generation += 1;
  }

  onMessage(message) {
    if (message.protocol && message.protocol !== PROTOCOL) return;
    if (message.type === "READY") { status.textContent = "Pyodide ready; running automated gate."; return; }
    if (message.type === "API_CALL") { void this.handleCall(message); return; }
    if (!this.active || message.runId !== this.active.runId) return;
    if (message.type === "RESULT") {
      const active = this.active;
      this.active = null;
      message.ok ? active.resolve(message) : active.reject(Object.assign(new Error(message.error), { code: message.code, result: message }));
    } else if (message.type === "STOPPED") {
      const active = this.active;
      this.active = null;
      active.reject(Object.assign(new Error(message.reason || "stopped"), { code: "STOPPED" }));
    }
  }

  async handleCall(message) {
    try {
      const value = await this.call(message.method, message.args || {});
      this.worker.postMessage({ protocol: PROTOCOL, type: "API_RESULT", runId: message.runId, callId: message.callId, result: value });
    } catch (error) {
      this.worker.postMessage({ protocol: PROTOCOL, type: "API_ERROR", runId: message.runId, callId: message.callId, code: error.code || "SIM_ERROR", error: error.message });
    }
  }

  async call(method, args) {
    if (method === "robot.connect") {
      if (this.state.connected) throw new Error("Simulated SO-101 is already connected.");
      this.state.connected = true;
      this.state.events.push("connect");
      return null;
    }
    if (method === "robot.disconnect") {
      if (!this.state.connected) throw new Error("Simulated SO-101 is not connected.");
      this.state.connected = false;
      this.state.events.push("disconnect");
      return null;
    }
    if (method === "robot.send_action") {
      if (!this.state.connected) throw new Error("Simulated SO-101 is not connected.");
      const action = args.action;
      if (!action || typeof action !== "object" || Array.isArray(action)) throw new TypeError("action must be a dict");
      const entries = Object.entries(action);
      if (!entries.length) throw new ValueError("send_action requires at least one .pos field");
      for (const [key, value] of entries) {
        if (!(key in this.state.target)) throw new Error(`Unknown SO-101 action field: ${key}`);
        if (!Number.isFinite(value)) throw new TypeError(`${key} must be finite`);
      }
      Object.assign(this.state.target, action);
      this.state.events.push("send_action");
      return { ...action };
    }
    if (method === "robot.get_observation") {
      if (!this.state.connected) throw new Error("Simulated SO-101 is not connected.");
      this.state.events.push("get_observation");
      return { ...this.state.actual };
    }
    if (method === "clock.now") return this.state.clock;
    if (method === "clock.sleep") {
      const seconds = Number(args.seconds);
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error("sleep seconds must be finite and non-negative");
      this.state.sleeping = true;
      let remaining = seconds;
      while (remaining > 1e-12) {
        while (this.state.paused) await delay(5);
        if (this.state.stopped) throw Object.assign(new Error("STOPPED: simulation sleep cancelled"), { code: "STOPPED" });
        const dt = Math.min(TICK_SECONDS, remaining);
        for (const key of Object.keys(this.state.actual)) {
          const difference = this.state.target[key] - this.state.actual[key];
          const step = Math.sign(difference) * Math.min(Math.abs(difference), 100 * dt);
          this.state.actual[key] += step;
        }
        this.state.clock = Number((this.state.clock + dt).toFixed(12));
        remaining -= dt;
        await delay(1);
      }
      this.state.sleeping = false;
      return null;
    }
    throw Object.assign(new Error(`Unsupported phase-0 method: ${method}`), { code: "UNSUPPORTED" });
  }

  run(source) {
    if (this.active) return Promise.reject(Object.assign(new Error("A script is active."), { code: "RUN_ACTIVE" }));
    const runId = `gate-${Date.now()}-${++this.counter}`;
    return new Promise((resolve, reject) => {
      this.active = { runId, resolve, reject };
      this.worker.postMessage({ protocol: PROTOCOL, type: "RUN", runId, source });
    });
  }

  pause() { this.state.paused = true; }
  resume() { this.state.paused = false; }

  stop(reason = "user") {
    if (!this.active) return false;
    this.state.stopped = true;
    this.state.mobile = { x: 0, y: 0, theta: 0 };
    this.worker.postMessage({ protocol: PROTOCOL, type: "CANCEL", runId: this.active.runId, reason });
    const worker = this.worker;
    setTimeout(() => worker.terminate(), 25);
    return true;
  }

  reset() {
    if (this.active) this.stop("reset");
    this.worker.terminate();
    this.active = null;
    this.state = baseline();
    this.createWorker();
  }

  rejectActive(code, message) {
    if (!this.active) return;
    const active = this.active;
    this.active = null;
    active.reject(Object.assign(new Error(message), { code }));
  }
}

const BASIC_SOURCE = `
import json
import time
from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig

def main():
    config = SO101FollowerConfig(port="sim://so101", id="phase0", cameras={})
    robot = SO101Follower(config)
    robot.connect()
    try:
        sent = robot.send_action({"shoulder_pan.pos": 4.0})
        start = time.monotonic()
        time.sleep(0.08)
        observation = robot.get_observation()
        assert sent == {"shoulder_pan.pos": 4.0}
        assert observation["shoulder_pan.pos"] > 0.0
        assert time.monotonic() - start >= 0.08
        print(json.dumps({"name": __name__, "sent": sent, "observation": observation}))
    finally:
        robot.disconnect()

if __name__ == "__main__":
    main()
`;

const PAUSE_SOURCE = BASIC_SOURCE.replace("time.sleep(0.08)", "time.sleep(0.30)");
const STOP_SOURCE = BASIC_SOURCE.replace("time.sleep(0.08)", "time.sleep(5.0)");
const ERROR_SOURCE = BASIC_SOURCE.replace('{"shoulder_pan.pos": 4.0}', '{"invented.pos": 4.0}').replace('assert sent == {"shoulder_pan.pos": 4.0}', "assert False");

const controller = new GateController();

async function waitFor(predicate, timeoutMs = 30000) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error("Timed out waiting for gate state.");
    await delay(5);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function automatedGate() {
  const checks = [];
  const basic = await controller.run(BASIC_SOURCE);
  assert(basic.canRunSync === true, "can_run_sync() was not true under runPythonAsync");
  assert(basic.stdout.includes('"name": "__main__"'), "whole-script __main__ execution was not observed");
  assert(controller.state.events.join(",") === "connect,send_action,get_observation,disconnect", "official-style connect/action/observe/finally-disconnect order failed");
  checks.push("whole synchronous official-style script and error-free finally cleanup");

  controller.reset();
  const pausedRun = controller.run(PAUSE_SOURCE);
  await waitFor(() => controller.state.sleeping);
  controller.pause();
  const pausedAt = controller.state.clock;
  await delay(80);
  assert(controller.state.clock === pausedAt, "Pause did not suspend simulation sleep/clock");
  controller.resume();
  await pausedRun;
  checks.push("Pause/Resume freezes and resumes simulation time and sleep");

  controller.reset();
  let error;
  try { await controller.run(ERROR_SOURCE); } catch (caught) { error = caught; }
  assert(error?.code === "PYTHON_ERROR", "bridge error did not propagate as a Python run error");
  assert(controller.state.events.at(-1) === "disconnect", "disconnect in finally did not run after bridge error");
  checks.push("bridge error propagation with disconnect in finally");

  controller.reset();
  const stoppedRun = controller.run(STOP_SOURCE);
  await waitFor(() => controller.state.sleeping);
  const stoppedAt = controller.state.clock;
  controller.stop("phase0-stop");
  let stoppedError;
  try { await stoppedRun; } catch (caught) { stoppedError = caught; }
  assert(stoppedError?.code === "STOPPED", "STOP did not reject the active run");
  assert(controller.state.clock >= stoppedAt && controller.state.clock < 5, "STOP did not preserve an incremental actual state");
  assert(Object.values(controller.state.mobile).every((value) => value === 0), "STOP did not zero mobile commands");
  checks.push("STOP rejects pending work, zeros mobile command, preserves last state, and terminates worker");

  controller.reset();
  assert(controller.state.clock === 0 && controller.state.events.length === 0 && !controller.state.connected, "Reset did not reconstruct canonical baseline");
  checks.push("Reset reconstructs baseline and clears clock/events/transient state");

  return { ok: true, protocol: PROTOCOL, pyodide: "0.29.4", tickSeconds: TICK_SECONDS, browser: navigator.userAgent, checks };
}

async function showGate() {
  status.textContent = "Running automated JSPI deployment-origin gate...";
  try {
    const report = await automatedGate();
    status.textContent = "PASS: JSPI synchronous-Python gate completed.";
    status.dataset.status = "pass";
    resultElement.textContent = JSON.stringify(report, null, 2);
    resultElement.dataset.complete = "true";
    document.documentElement.dataset.gate = "pass";
  } catch (error) {
    status.textContent = `FAIL: ${error.message}`;
    status.dataset.status = "fail";
    resultElement.textContent = JSON.stringify({ ok: false, error: error.message, stack: error.stack, browser: navigator.userAgent }, null, 2);
    resultElement.dataset.complete = "true";
    document.documentElement.dataset.gate = "fail";
  }
}

document.getElementById("run").addEventListener("click", showGate);
document.getElementById("pause").addEventListener("click", () => controller.pause());
document.getElementById("resume").addEventListener("click", () => controller.resume());
document.getElementById("stop").addEventListener("click", () => controller.stop("ui-stop"));
document.getElementById("reset").addEventListener("click", () => controller.reset());

void showGate();
