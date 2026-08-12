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

manifest = json.loads(__MANIFEST_JSON__)
robot_id = str(manifest.get("id") or __ACTIVE_ROBOT_ID__ or "arduino_arm")
initial_joints = json.loads(__INITIAL_JOINTS_JSON__)
initial_poses = json.loads(__POSES_JSON__)
max_commands = int(__MAX_COMMANDS__)

SAFETY = {
    "speed_min": 1,
    "speed_max": 100,
    "wait_min": 0,
    "wait_max": 30,
    "smooth_min": 0.2,
    "smooth_max": 10,
}

def _safe_float(value, name):
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a number")
    try:
        return float(value)
    except Exception:
        raise ValueError(f"{name} must be a number")

def _safe_int(value, name):
    return int(round(_safe_float(value, name)))

def _norm_key(value):
    return str(value).strip().lower().replace("-", "_").replace(" ", "_")

def _joints():
    return list(manifest.get("joints") or [])

def _gripper_joints():
    return [joint for joint in _joints() if joint.get("type") == "gripper"]

def _gripper_side(joint):
    declared = _norm_key(joint.get("side", ""))
    if declared in ("left", "right"):
        return declared
    joint_id = _norm_key(joint.get("id", ""))
    if joint_id.startswith("left_"):
        return "left"
    if joint_id.startswith("right_"):
        return "right"
    return ""

def _joint_aliases():
    aliases = {}
    for index, joint in enumerate(_joints()):
        aliases[_norm_key(joint.get("id"))] = joint
        aliases[_norm_key(joint.get("label"))] = joint
        aliases[str(index)] = joint
        if robot_id == "arduino_arm" and "servoIndex" in joint:
            aliases[str(joint.get("servoIndex"))] = joint
    if robot_id == "arduino_arm":
        aliases.update({
            "wrist_rotation": aliases.get("wrist_rot"),
            "wristrotate": aliases.get("wrist_rot"),
            "wrist_tilt": aliases.get("wrist_tilt"),
        })
    return aliases

def _joint(joint):
    aliases = _joint_aliases()
    key = _norm_key(joint)
    if key in aliases and aliases[key]:
        return aliases[key]
    raise ValueError("joint must be one of " + ", ".join(j.get("id") for j in _joints()))

def _joint_value(joint, value):
    numeric = _safe_float(value, f"{joint.get('label', joint.get('id'))} value")
    low = float(joint.get("min", 0))
    high = float(joint.get("max", 180))
    if numeric < low or numeric > high:
        raise ValueError(f"{joint.get('label', joint.get('id'))} value must be {low:g}..{high:g}")
    return int(round(numeric)) if joint.get("unit") != "percent" else numeric

def _speed(value=50, joint=None):
    speed = _safe_int(value, "speed")
    low = int(joint.get("speedMin", SAFETY["speed_min"])) if isinstance(joint, dict) else SAFETY["speed_min"]
    high = int(joint.get("speedMax", SAFETY["speed_max"])) if isinstance(joint, dict) else SAFETY["speed_max"]
    if speed < low or speed > high:
        raise ValueError(f"speed must be {low}..{high}")
    return speed

def _seconds(value, name="seconds", low=None, high=None):
    seconds = _safe_float(value, name)
    low = SAFETY["wait_min"] if low is None else low
    high = SAFETY["wait_max"] if high is None else high
    if seconds < low or seconds > high:
        raise ValueError(f"{name} must be {low:g}..{high:g}")
    return seconds

def _has_capability(name):
    return name in set(manifest.get("capabilities") or [])

def _home_joints():
    return {str(j.get("id")): float(j.get("home", j.get("min", 0))) for j in _joints()}

def _require_mobile():
    if not manifest.get("mobileBase") or not (_has_capability("drive_2d") or _has_capability("holonomic_drive")):
        raise ValueError("drive commands require a robot with mobile-base capability")

def _name(value):
    text = str(value).strip()
    if not text:
        raise ValueError("pose name cannot be empty")
    return text[:40]

class Robot:
    def __init__(self):
        self.commands = []
        self.joints = _home_joints()
        if isinstance(initial_joints, dict):
            for joint in _joints():
                key = joint.get("id")
                if key in initial_joints:
                    self.joints[key] = _joint_value(joint, initial_joints[key])
        self.poses = {}
        if isinstance(initial_poses, dict):
            for pose_name, pose_joints in initial_poses.items():
                if isinstance(pose_joints, dict):
                    safe = {}
                    for key, value in pose_joints.items():
                        joint = _joint(key)
                        safe[joint.get("id")] = _joint_value(joint, value)
                    self.poses[str(pose_name)] = safe

    def _append(self, command):
        if len(self.commands) >= max_commands:
            raise ValueError(f"Python program exceeded the {max_commands} command limit")
        self.commands.append(command)

    def home(self):
        self.joints = _home_joints()
        self._append({"type": "home", "robotId": robot_id})

    def stop(self):
        self._append({"type": "stop", "robotId": robot_id, "reason": "user"})

    def emergency_stop(self):
        self.stop()

    def wait(self, seconds):
        self._append({"type": "wait", "robotId": robot_id, "seconds": _seconds(seconds)})

    def move_joint(self, joint, value, speed=50):
        joint_def = _joint(joint)
        safe_value = _joint_value(joint_def, value)
        self.joints[joint_def.get("id")] = safe_value
        self._append({
            "type": "move_joint",
            "robotId": robot_id,
            "joint": joint_def.get("id"),
            "value": safe_value,
            "unit": joint_def.get("unit", "deg"),
            "speed": _speed(speed, joint_def),
        })

    def move_joints(self, joints, speed=50):
        if not isinstance(joints, dict):
            raise ValueError("move_joints expects a dict of joint names to values")
        safe = {}
        for key, value in joints.items():
            joint_def = _joint(key)
            safe_value = _joint_value(joint_def, value)
            safe[joint_def.get("id")] = safe_value
            self.joints[joint_def.get("id")] = safe_value
        if not safe:
            raise ValueError("move_joints requires at least one joint")
        self._append({"type": "move_joints", "robotId": robot_id, "joints": safe, "unit": "deg", "speed": _speed(speed)})

    def move_arm(self, base=None, shoulder=None, elbow=None, wrist_rot=None, wrist_tilt=None, gripper=None, speed=50):
        values = {
            "base": base,
            "shoulder": shoulder,
            "elbow": elbow,
            "wrist_rot": wrist_rot,
            "wrist_tilt": wrist_tilt,
            "gripper": gripper,
        }
        requested = {key: value for key, value in values.items() if value is not None}
        if not requested:
            requested = {joint.get("id"): self.joints.get(joint.get("id"), joint.get("home", 0)) for joint in _joints()}
        self.move_joints(requested, speed=speed)

    def set_gripper(self, value, speed=55, side="both"):
        grippers = _gripper_joints()
        if not grippers:
            raise ValueError("active robot does not define a gripper joint")
        if len(grippers) == 1:
            joint_def = grippers[0]
            target = joint_def.get("open") if value == "open" else joint_def.get("close") if value in ("close", "closed") else value
            safe_value = _joint_value(joint_def, target)
            self.joints[joint_def.get("id")] = safe_value
            self._append({"type": "set_gripper", "robotId": robot_id, "value": safe_value, "speed": _speed(speed, joint_def)})
            return

        normalized_side = _norm_key(side or "both")
        if normalized_side not in ("left", "right", "both"):
            raise ValueError("gripper side must be left, right, or both")
        targets = [joint for joint in grippers if normalized_side == "both" or _gripper_side(joint) == normalized_side]
        if not targets:
            raise ValueError(f"active robot does not define a {normalized_side} gripper")
        safe = {}
        for joint_def in targets:
            target = joint_def.get("open") if value == "open" else joint_def.get("close") if value in ("close", "closed") else value
            safe_value = _joint_value(joint_def, target)
            safe[joint_def.get("id")] = safe_value
            self.joints[joint_def.get("id")] = safe_value
        self._append({
            "type": "set_gripper",
            "robotId": robot_id,
            "side": normalized_side,
            "joints": safe,
            "speed": _speed(speed, targets[0]),
        })

    def open_gripper(self, speed=55, side="both"):
        self.set_gripper("open", speed=speed, side=side)

    def close_gripper(self, speed=55, side="both"):
        self.set_gripper("close", speed=speed, side=side)

    def set_left_gripper(self, value, speed=55):
        self.set_gripper(value, speed=speed, side="left")

    def set_right_gripper(self, value, speed=55):
        self.set_gripper(value, speed=speed, side="right")

    def gripper_open(self, speed=55, side="both"):
        self.open_gripper(speed=speed, side=side)

    def gripper_close(self, speed=55, side="both"):
        self.close_gripper(speed=speed, side=side)

    def smooth_move(self, joint, start, end, seconds=1.5):
        joint_def = _joint(joint)
        safe_start = _joint_value(joint_def, start)
        safe_end = _joint_value(joint_def, end)
        duration = _seconds(seconds, "smooth_move seconds", SAFETY["smooth_min"], SAFETY["smooth_max"])
        self.joints[joint_def.get("id")] = safe_end
        self._append({
            "type": "smooth_move",
            "robotId": robot_id,
            "joint": joint_def.get("id"),
            "from": safe_start,
            "to": safe_end,
            "seconds": duration,
        })

    def save_pose(self, name):
        safe_name = _name(name)
        self.poses[safe_name] = dict(self.joints)
        self._append({"type": "savePose", "name": safe_name})

    def go_to_pose(self, name, speed=50):
        safe_name = _name(name)
        if safe_name in self.poses:
            self.joints = dict(self.poses[safe_name])
        self._append({"type": "goPose", "name": safe_name, "speed": _speed(speed)})

    def drive(self, vx_percent, vy_percent=0, omega=0, seconds=1.0, frame="robot"):
        _require_mobile()
        mobile = manifest.get("mobileBase") or {}
        max_linear = float(mobile.get("maxLinearSpeed", 1.0))
        max_angular = float(mobile.get("maxAngularSpeed", 90))
        vx = _safe_float(vx_percent, "vx percent") / 100.0 * max_linear
        vy = _safe_float(vy_percent, "vy percent") / 100.0 * max_linear
        om = _safe_float(omega, "omega")
        if om < -max_angular or om > max_angular:
            raise ValueError(f"omega must be {-max_angular:g}..{max_angular:g}")
        self._append({
            "type": "drive",
            "robotId": robot_id,
            "vx": vx,
            "vy": vy,
            "omega": om,
            "seconds": _seconds(seconds),
            "frame": "world" if frame == "world" else "robot",
        })

    def drive_forward(self, speed_percent, seconds=1.0):
        self.drive(abs(_safe_float(speed_percent, "speed percent")), 0, 0, seconds=seconds)

    def drive_backward(self, speed_percent, seconds=1.0):
        self.drive(-abs(_safe_float(speed_percent, "speed percent")), 0, 0, seconds=seconds)

    def strafe_left(self, speed_percent, seconds=1.0):
        self.drive(0, abs(_safe_float(speed_percent, "speed percent")), 0, seconds=seconds)

    def strafe_right(self, speed_percent, seconds=1.0):
        self.drive(0, -abs(_safe_float(speed_percent, "speed percent")), 0, seconds=seconds)

    def turn_left(self, omega=45, seconds=1.0):
        self.drive(0, 0, abs(_safe_float(omega, "omega")), seconds=seconds)

    def turn_right(self, omega=45, seconds=1.0):
        self.drive(0, 0, -abs(_safe_float(omega, "omega")), seconds=seconds)

    def get_state(self):
        return {"robotId": robot_id, "joints": dict(self.joints)}

    def get_joints(self):
        return dict(self.joints)

    def get_angles(self):
        return [self.joints.get(joint.get("id"), joint.get("home", 0)) for joint in _joints()]

robot = Robot()
arm = robot

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

stdout_buffer = io.StringIO()
stderr_buffer = io.StringIO()
exec_globals = {
    "__builtins__": safe_builtins,
    "arm": arm,
    "robot": robot,
    "math": math,
}

try:
    with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
        exec(__USER_CODE__, exec_globals, exec_globals)
    __result = {
        "ok": True,
        "commands": robot.commands,
        "angles": robot.get_angles(),
        "joints": robot.get_joints(),
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "error": "",
        "traceback": "",
    }
except Exception as exc:
    __result = {
        "ok": False,
        "commands": robot.commands,
        "angles": robot.get_angles(),
        "joints": robot.get_joints(),
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
    const manifest = data.manifest && typeof data.manifest === "object" ? data.manifest : {};
    pyodide.globals.set("__USER_CODE__", String(data.python || ""));
    pyodide.globals.set("__MANIFEST_JSON__", JSON.stringify(manifest));
    pyodide.globals.set("__ACTIVE_ROBOT_ID__", String(data.activeRobotId || manifest.id || "arduino_arm"));
    pyodide.globals.set("__INITIAL_JOINTS_JSON__", JSON.stringify(data.initialJoints && typeof data.initialJoints === "object" ? data.initialJoints : {}));
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
      joints: {},
      stdout: "",
      stderr: "",
      error: error && error.message ? error.message : String(error),
      traceback: ""
    });
  }
});

void loadRuntime();
