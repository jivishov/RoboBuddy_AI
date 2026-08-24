const PROTOCOL = "robobuddy.jspi-origin-gate.v1";
const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/pyodide.js";

let readyPromise;
let activeRun = null;

function post(type, payload = {}) {
  self.postMessage({ protocol: PROTOCOL, type, ...payload });
}

function runtime() {
  if (!readyPromise) {
    readyPromise = (async () => {
      importScripts(PYODIDE_URL);
      const pyodide = await loadPyodide();
      post("READY");
      return pyodide;
    })();
  }
  return readyPromise;
}

const BOOTSTRAP = String.raw`
import contextlib
import io
import json
import sys
import time as _time
import traceback
import types
from dataclasses import dataclass, field
from pyodide.ffi import can_run_sync, run_sync

_stdout = io.StringIO()
_stderr = io.StringIO()

def _rpc(method, args=None):
    payload = {} if args is None else args
    return json.loads(str(run_sync(__robobuddy_api_call(str(method), json.dumps(payload)))))

def _sim_sleep(seconds):
    seconds = float(seconds)
    if seconds < 0:
        raise ValueError("sleep length must be non-negative")
    _rpc("clock.sleep", {"seconds": seconds})

def _sim_now():
    return float(_rpc("clock.now"))

_time.sleep = _sim_sleep
_time.monotonic = _sim_now
_time.perf_counter = _sim_now

@dataclass(kw_only=True)
class RobotConfig:
    id: str | None = None
    calibration_dir: object | None = None

@dataclass
class SOFollowerConfig:
    port: str
    disable_torque_on_disconnect: bool = True
    max_relative_target: float | dict[str, float] | None = None
    cameras: dict = field(default_factory=dict)
    use_degrees: bool = True
    position_p_coefficient: int = 16
    position_i_coefficient: int = 0
    position_d_coefficient: int = 32
    num_read_retries: int = 2

@dataclass
class SOFollowerRobotConfig(RobotConfig, SOFollowerConfig):
    pass

SO101FollowerConfig = SOFollowerRobotConfig

class SOFollower:
    def __init__(self, config):
        if not isinstance(config, SOFollowerRobotConfig):
            raise TypeError("config must be an SOFollowerRobotConfig")
        if config.cameras:
            raise NotImplementedError("Cameras are not available in the browser simulation; use cameras={}." )
        self.config = config
        self._connected = False

    @property
    def is_connected(self):
        return self._connected

    @property
    def is_calibrated(self):
        return True

    def connect(self, calibrate=True):
        if self._connected:
            raise RuntimeError("SOFollower is already connected.")
        _rpc("robot.connect", {"calibrate": bool(calibrate)})
        self._connected = True

    def disconnect(self):
        if not self._connected:
            raise RuntimeError("SOFollower is not connected.")
        _rpc("robot.disconnect")
        self._connected = False

    def send_action(self, action):
        if not self._connected:
            raise RuntimeError("SOFollower is not connected.")
        return _rpc("robot.send_action", {"action": dict(action)})

    def get_observation(self):
        if not self._connected:
            raise RuntimeError("SOFollower is not connected.")
        return _rpc("robot.get_observation")

    def calibrate(self):
        raise NotImplementedError("Explicit calibration is hardware-only; the browser uses a preloaded simulated calibration.")

    def setup_motors(self):
        raise NotImplementedError("setup_motors is hardware-only and unavailable in the browser simulation.")

SO101Follower = SOFollower

lerobot = types.ModuleType("lerobot")
robots = types.ModuleType("lerobot.robots")
so_follower = types.ModuleType("lerobot.robots.so_follower")
for name, value in {
    "SOFollower": SOFollower,
    "SO101Follower": SO101Follower,
    "SOFollowerConfig": SOFollowerConfig,
    "SOFollowerRobotConfig": SOFollowerRobotConfig,
    "SO101FollowerConfig": SO101FollowerConfig,
}.items():
    setattr(so_follower, name, value)
robots.so_follower = so_follower
lerobot.robots = robots
sys.modules.update({
    "lerobot": lerobot,
    "lerobot.robots": robots,
    "lerobot.robots.so_follower": so_follower,
})

_namespace = {"__name__": "__main__"}
try:
    if not can_run_sync():
        raise RuntimeError("pyodide.ffi.can_run_sync() is false under runPythonAsync")
    with contextlib.redirect_stdout(_stdout), contextlib.redirect_stderr(_stderr):
        exec(__USER_CODE__, _namespace, _namespace)
    __gate_result = {
        "ok": True,
        "canRunSync": True,
        "stdout": _stdout.getvalue(),
        "stderr": _stderr.getvalue(),
        "error": "",
        "traceback": "",
    }
except BaseException as exc:
    __gate_result = {
        "ok": False,
        "canRunSync": bool(can_run_sync()),
        "stdout": _stdout.getvalue(),
        "stderr": _stderr.getvalue(),
        "error": f"{type(exc).__name__}: {exc}",
        "traceback": traceback.format_exc(limit=8),
    }
json.dumps(__gate_result)
`;

async function execute(data) {
  if (activeRun) {
    post("RESULT", { runId: data.runId, ok: false, code: "RUN_ACTIVE", error: "A gate script is already running." });
    return;
  }
  const run = { runId: data.runId, pending: new Map(), counter: 0, cancelled: false };
  activeRun = run;
  try {
    const pyodide = await runtime();
    const apiCall = (method, argsJson) => {
      if (run.cancelled || activeRun !== run) return Promise.reject(new Error("Python run stopped."));
      const callId = `${run.runId}:${++run.counter}`;
      return new Promise((resolve, reject) => {
        run.pending.set(callId, { resolve, reject });
        post("API_CALL", { runId: run.runId, callId, method: String(method), args: JSON.parse(String(argsJson || "{}")) });
      });
    };
    pyodide.globals.set("__robobuddy_api_call", apiCall);
    pyodide.globals.set("__USER_CODE__", String(data.source || ""));
    const text = await pyodide.runPythonAsync(BOOTSTRAP);
    if (activeRun !== run || run.cancelled) return;
    const result = JSON.parse(String(text || "{}"));
    post("RESULT", { runId: run.runId, ...result, code: result.ok ? "PYTHON_COMPLETE" : "PYTHON_ERROR" });
  } catch (error) {
    if (activeRun === run && !run.cancelled) {
      post("RESULT", { runId: run.runId, ok: false, code: "PYTHON_ERROR", error: error?.message || String(error) });
    }
  } finally {
    if (activeRun === run) activeRun = null;
  }
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.protocol !== PROTOCOL) return;
  if (data.type === "RUN") { void execute(data); return; }
  const run = activeRun;
  if (!run || data.runId !== run.runId) return;
  if (data.type === "API_RESULT" || data.type === "API_ERROR") {
    const pending = run.pending.get(data.callId);
    if (!pending) return;
    run.pending.delete(data.callId);
    if (data.type === "API_RESULT") pending.resolve(JSON.stringify(data.result ?? null));
    else pending.reject(new Error(`${data.code || "API_ERROR"}: ${data.error || "API call failed."}`));
    return;
  }
  if (data.type === "CANCEL") {
    run.cancelled = true;
    run.pending.forEach(({ reject }) => reject(new Error(data.reason || "stopped")));
    run.pending.clear();
    post("STOPPED", { runId: run.runId, reason: data.reason || "stopped" });
    if (activeRun === run) activeRun = null;
  }
});

void runtime();
