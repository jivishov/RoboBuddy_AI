const PYODIDE_VERSION = "0.29.4";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.js`;

let pyodideReadyPromise = null;

function loadRuntime() {
  if (!pyodideReadyPromise) {
    pyodideReadyPromise = (async () => {
      self.postMessage({ type: "status", phase: "loading" });
      importScripts(PYODIDE_URL);
      const pyodide = await loadPyodide();
      self.postMessage({ type: "status", phase: "ready" });
      return pyodide;
    })();
  }
  return pyodideReadyPromise;
}

const RUNTIME_CODE = `
import contextlib
import io
import json
import math
import traceback

JOINT_NAMES = ["base", "shoulder", "elbow", "wrist_rot", "wrist_tilt", "gripper"]
JOINT_ALIASES = {
    "base": 0,
    "shoulder": 1,
    "elbow": 2,
    "wrist_rot": 3,
    "wrist_rotation": 3,
    "wrist tilt": 4,
    "wrist_tilt": 4,
    "gripper": 5,
}
GRIPPER_OPEN_ANGLE = 50
GRIPPER_CLOSE_ANGLE = 120
GRIPPER_DEFAULT_SPEED = 55

initial_angles = json.loads(__INITIAL_ANGLES_JSON__)
joint_limits = json.loads(__JOINT_LIMITS_JSON__)
initial_poses = json.loads(__POSES_JSON__)
max_commands = int(__MAX_COMMANDS__)

def _safe_int(value, name):
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a number")
    try:
        return int(round(float(value)))
    except Exception:
        raise ValueError(f"{name} must be a number")

def _joint_index(joint):
    if isinstance(joint, str):
        key = joint.strip().lower().replace("-", "_").replace(" ", "_")
        if key in JOINT_ALIASES:
            return JOINT_ALIASES[key]
    idx = _safe_int(joint, "joint")
    if idx < 0 or idx >= 6:
        raise ValueError("joint must be one of base, shoulder, elbow, wrist_rot, wrist_tilt, gripper, or 0..5")
    return idx

def _speed(value):
    speed = _safe_int(value, "speed")
    if speed < 1 or speed > 100:
        raise ValueError("speed must be 1..100")
    return speed

def _angle(servo, value):
    angle = _safe_int(value, "angle")
    low, high = joint_limits[servo]
    if angle < low or angle > high:
        raise ValueError(f"{JOINT_NAMES[servo]} angle must be {low}..{high}")
    return angle

def _name(value):
    text = str(value).strip()
    if not text:
        raise ValueError("pose name cannot be empty")
    return text[:40]

class Arm:
    def __init__(self):
        self.commands = []
        self.angles = []
        for index in range(6):
            fallback = 90
            raw = initial_angles[index] if index < len(initial_angles) else fallback
            self.angles.append(_angle(index, raw))
        self.poses = {}
        if isinstance(initial_poses, dict):
            for pose_name, pose_angles in initial_poses.items():
                if isinstance(pose_angles, list) and len(pose_angles) >= 6:
                    self.poses[str(pose_name)] = [_angle(i, pose_angles[i]) for i in range(6)]

    def _append(self, command):
        if len(self.commands) >= max_commands:
            raise ValueError(f"Python program exceeded the {max_commands} command limit")
        self.commands.append(command)

    def move_joint(self, joint, angle, speed=50):
        servo = _joint_index(joint)
        safe_angle = _angle(servo, angle)
        safe_speed = _speed(speed)
        self.angles[servo] = safe_angle
        self._append({"type": "servo", "servo": servo, "angle": safe_angle, "speed": safe_speed})

    def move_arm(self, base=None, shoulder=None, elbow=None, wrist_rot=None, wrist_tilt=None, gripper=None, speed=50):
        values = [base, shoulder, elbow, wrist_rot, wrist_tilt, gripper]
        safe_speed = _speed(speed)
        for servo, value in enumerate(values):
            target = self.angles[servo] if value is None else value
            safe_angle = _angle(servo, target)
            self.angles[servo] = safe_angle
            self._append({"type": "servo", "servo": servo, "angle": safe_angle, "speed": safe_speed})

    def home(self):
        self.angles = [90, 90, 90, 90, 90, 90]
        self._append({"type": "home"})

    def wait(self, seconds):
        try:
            value = float(seconds)
        except Exception:
            raise ValueError("wait seconds must be a number")
        if value < 0 or value > 30:
            raise ValueError("wait seconds must be 0..30")
        self._append({"type": "delay", "ms": int(round(value * 1000))})

    def gripper_open(self, speed=GRIPPER_DEFAULT_SPEED):
        self.move_joint("gripper", GRIPPER_OPEN_ANGLE, speed=speed)

    def gripper_close(self, speed=GRIPPER_DEFAULT_SPEED):
        self.move_joint("gripper", GRIPPER_CLOSE_ANGLE, speed=speed)

    def smooth_move(self, joint, start, end, seconds=1.5):
        servo = _joint_index(joint)
        safe_start = _angle(servo, start)
        safe_end = _angle(servo, end)
        try:
            value = float(seconds)
        except Exception:
            raise ValueError("smooth_move seconds must be a number")
        if value < 0.2 or value > 10:
            raise ValueError("smooth_move seconds must be 0.2..10")
        self.angles[servo] = safe_end
        self._append({
            "type": "smoothMove",
            "servo": servo,
            "from": safe_start,
            "to": safe_end,
            "durationMs": int(round(value * 1000)),
        })

    def save_pose(self, name):
        safe_name = _name(name)
        self.poses[safe_name] = list(self.angles)
        self._append({"type": "savePose", "name": safe_name})

    def go_to_pose(self, name, speed=50):
        safe_name = _name(name)
        safe_speed = _speed(speed)
        if safe_name in self.poses:
            self.angles = list(self.poses[safe_name])
        self._append({"type": "goPose", "name": safe_name, "speed": safe_speed})

    def emergency_stop(self):
        self._append({"type": "emergencyStop"})

    def get_angles(self):
        return list(self.angles)

safe_builtins = {
    "abs": abs,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "print": print,
    "range": range,
    "round": round,
    "str": str,
    "sum": sum,
    "tuple": tuple,
}

arm = Arm()
stdout_buffer = io.StringIO()
stderr_buffer = io.StringIO()
exec_globals = {
    "__builtins__": safe_builtins,
    "arm": arm,
    "math": math,
}

try:
    with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
        exec(__USER_CODE__, exec_globals, exec_globals)
    __result = {
        "ok": True,
        "commands": arm.commands,
        "angles": arm.get_angles(),
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "error": "",
        "traceback": "",
    }
except Exception as exc:
    __result = {
        "ok": False,
        "commands": arm.commands,
        "angles": arm.get_angles(),
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "error": f"{type(exc).__name__}: {exc}",
        "traceback": traceback.format_exc(limit=6),
    }

json.dumps(__result)
`;

self.addEventListener("message", async (event) => {
  const data = event.data || {};
  if (data.type !== "run") {
    return;
  }

  const id = data.id;
  try {
    const pyodide = await loadRuntime();
    pyodide.globals.set("__USER_CODE__", String(data.python || ""));
    pyodide.globals.set("__INITIAL_ANGLES_JSON__", JSON.stringify(Array.isArray(data.initialAngles) ? data.initialAngles : []));
    pyodide.globals.set("__JOINT_LIMITS_JSON__", JSON.stringify(Array.isArray(data.jointLimits) ? data.jointLimits : []));
    pyodide.globals.set("__POSES_JSON__", JSON.stringify(data.poses && typeof data.poses === "object" ? data.poses : {}));
    pyodide.globals.set("__MAX_COMMANDS__", Number.isFinite(data.maxCommands) ? Math.max(1, Math.round(data.maxCommands)) : 1000);

    const resultText = await pyodide.runPythonAsync(RUNTIME_CODE);
    const result = JSON.parse(String(resultText || "{}"));
    self.postMessage({ type: "result", id, ...result });
  } catch (error) {
    self.postMessage({
      type: "result",
      id,
      ok: false,
      commands: [],
      angles: [],
      stdout: "",
      stderr: "",
      error: error && error.message ? error.message : String(error),
      traceback: ""
    });
  }
});

void loadRuntime();
