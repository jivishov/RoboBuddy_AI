"""RoboBuddy browser compatibility modules for pinned physical-source patterns.

This module is loaded inside the Pyodide worker.  It intentionally provides only
the reviewed LeRobot 0.6.1 and OpenArm ROS 2 0.9.2/Humble source patterns; it is
not the upstream hardware package, ROS 2, a controller emulator, or a digital
twin.
"""

from dataclasses import dataclass, field, asdict
from pathlib import Path
import contextlib
import io
import json
import math
import sys
import time as _time
import traceback
import types

from pyodide.ffi import can_run_sync, run_sync


_wall_time = _time.time
_instance_counter = 0


def _rpc(method, args=None):
    payload = {} if args is None else args
    text = run_sync(__robobuddy_api_call(str(method), json.dumps(payload)))
    return json.loads(str(text))


def _hardware_only(name):
    _rpc("compat.hardware_unsupported", {"name": name})


def _public_config(config):
    """Return only bridge-relevant values; never expose local calibration paths."""
    values = asdict(config)
    values.pop("calibration_dir", None)
    return values


def _sim_now():
    return float(_rpc("compat.clock.now"))


def _sim_sleep(seconds):
    seconds = float(seconds)
    if seconds < 0:
        raise ValueError("sleep length must be non-negative")
    _rpc("compat.clock.sleep", {"seconds": seconds})


def _install_simulation_time():
    _time.sleep = _sim_sleep
    _time.monotonic = _sim_now
    _time.perf_counter = _sim_now
    _time.time = _wall_time


def _module(name, **values):
    module = types.ModuleType(name)
    module.__dict__.update(values)
    sys.modules[name] = module
    parent, _, child = name.rpartition(".")
    if parent and parent in sys.modules:
        setattr(sys.modules[parent], child, module)
    return module


def _package(name):
    module = _module(name)
    module.__path__ = []
    return module


def _default_teleop_keys():
    return {"forward": "w", "backward": "s", "left": "a", "right": "d",
            "rotate_left": "z", "rotate_right": "x", "speed_up": "r",
            "speed_down": "f", "quit": "q"}


def _default_motor_config():
    types_by_joint = ["dm8009", "dm8009", "dm4340", "dm4340", "dm4310", "dm4310", "dm4310", "dm4310"]
    return {("gripper" if index == 8 else f"joint_{index}"): (index, index + 0x10, types_by_joint[index - 1]) for index in range(1, 9)}


def _safe_openarm_limits(side):
    if side == "left":
        return {"joint_1": (-75.0, 75.0), "joint_2": (-90.0, 9.0), "joint_3": (-85.0, 85.0), "joint_4": (0.0, 135.0), "joint_5": (-85.0, 85.0), "joint_6": (-40.0, 40.0), "joint_7": (-80.0, 80.0), "gripper": (-65.0, 0.0)}
    if side == "right":
        return {"joint_1": (-75.0, 75.0), "joint_2": (-9.0, 90.0), "joint_3": (-85.0, 85.0), "joint_4": (0.0, 135.0), "joint_5": (-85.0, 85.0), "joint_6": (-40.0, 40.0), "joint_7": (-80.0, 80.0), "gripper": (-65.0, 0.0)}
    return {"joint_1": (-5.0, 5.0), "joint_2": (-5.0, 5.0), "joint_3": (-5.0, 5.0), "joint_4": (0.0, 5.0), "joint_5": (-5.0, 5.0), "joint_6": (-5.0, 5.0), "joint_7": (-5.0, 5.0), "gripper": (-5.0, 0.0)}


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
    id: str | None = None
    calibration_dir: Path | None = None


SOFollowerRobotConfig = SOFollowerConfig
SO100FollowerConfig = SOFollowerConfig
SO101FollowerConfig = SOFollowerConfig


@dataclass
class LeKiwiClientConfig:
    remote_ip: str
    port_zmq_cmd: int = 5555
    port_zmq_observations: int = 5556
    teleop_keys: dict[str, str] = field(default_factory=_default_teleop_keys)
    cameras: dict = field(default_factory=lambda: {"front": "official-default", "wrist": "official-default"})
    polling_timeout_ms: int = 15
    connect_timeout_s: int = 5
    id: str | None = None
    calibration_dir: Path | None = None


@dataclass
class OpenArmFollowerConfigBase:
    port: str
    side: str | None = None
    can_interface: str = "socketcan"
    use_can_fd: bool = True
    can_bitrate: int = 1_000_000
    can_data_bitrate: int = 5_000_000
    disable_torque_on_disconnect: bool = True
    use_velocity_and_torque: bool = False
    max_relative_target: float | dict[str, float] | None = None
    cameras: dict = field(default_factory=dict)
    motor_config: dict = field(default_factory=_default_motor_config)
    position_kp: list[float] = field(default_factory=lambda: [240.0, 240.0, 240.0, 240.0, 24.0, 31.0, 25.0, 25.0])
    position_kd: list[float] = field(default_factory=lambda: [5.0, 5.0, 3.0, 5.0, 0.3, 0.3, 0.3, 0.3])
    joint_limits: dict[str, tuple[float, float]] | None = None
    id: str | None = None
    calibration_dir: Path | None = None

    def __post_init__(self):
        if self.side not in (None, "left", "right"):
            raise ValueError("side must be 'left', 'right', or None")
        if self.joint_limits is None:
            self.joint_limits = _safe_openarm_limits(self.side)


OpenArmFollowerConfig = OpenArmFollowerConfigBase


@dataclass(kw_only=True)
class BiOpenArmFollowerConfig:
    left_arm_config: OpenArmFollowerConfigBase
    right_arm_config: OpenArmFollowerConfigBase
    id: str | None = "bi_openarm_follower"
    cameras: dict = field(default_factory=dict)
    calibration_dir: Path | None = None


class _Robot:
    _profile = ""
    _state_keys = ()

    def __init__(self, config):
        global _instance_counter
        _instance_counter += 1
        self.config = config
        self._instance_id = f"{self._profile}-{_instance_counter}"
        self._connected = False

    @property
    def is_connected(self):
        return self._connected

    @property
    def is_calibrated(self):
        return True

    @property
    def observation_features(self):
        return {key: float for key in self._state_keys}

    @property
    def action_features(self):
        return {key: float for key in self._state_keys}

    def connect(self, calibrate=True):
        if self._connected:
            raise RuntimeError(f"{self.__class__.__name__} is already connected")
        config = _public_config(self.config)
        config["kind"] = self._profile
        _rpc("compat.connect", {"instanceId": self._instance_id, "config": config})
        self._connected = True

    def disconnect(self):
        if not self._connected:
            raise RuntimeError(f"{self.__class__.__name__} is not connected")
        _rpc("compat.disconnect", {"instanceId": self._instance_id})
        self._connected = False

    def get_observation(self):
        if not self._connected:
            raise RuntimeError(f"{self.__class__.__name__} is not connected")
        return _rpc("compat.get_observation", {"instanceId": self._instance_id})

    def send_action(self, action, **kwargs):
        if not self._connected:
            raise RuntimeError(f"{self.__class__.__name__} is not connected")
        return _rpc("compat.send_action", {"instanceId": self._instance_id, "action": dict(action), "options": kwargs})

    def calibrate(self):
        _hardware_only("calibrate")

    def setup_motors(self):
        _hardware_only("setup_motors")

    def configure(self):
        _hardware_only("configure")


class SOFollower(_Robot):
    _profile = "so101"
    _state_keys = ("shoulder_pan.pos", "shoulder_lift.pos", "elbow_flex.pos", "wrist_flex.pos", "wrist_roll.pos", "gripper.pos")


SO100Follower = SOFollower
SO101Follower = SOFollower


class LeKiwiClient(_Robot):
    _profile = "lekiwi"
    _state_keys = ("arm_shoulder_pan.pos", "arm_shoulder_lift.pos", "arm_elbow_flex.pos", "arm_wrist_flex.pos", "arm_wrist_roll.pos", "arm_gripper.pos", "x.vel", "y.vel", "theta.vel")

    def connect(self):
        super().connect()

    def calibrate(self):
        _hardware_only("LeKiwi host calibration")

    def send_action(self, action):
        import numpy as np
        result = super().send_action(action)
        values = {key: np.float32(result["values"][key]) for key in self._state_keys}
        values["action"] = np.asarray(result["vector"], dtype=np.float32)
        return values


class OpenArmFollower(_Robot):
    _profile = "openarm"
    _state_keys = tuple([f"joint_{index}.pos" for index in range(1, 8)] + ["gripper.pos"])

    def send_action(self, action, custom_kp=None, custom_kd=None):
        return super().send_action(action, customKp=custom_kp, customKd=custom_kd)


class BiOpenArmFollower(_Robot):
    _profile = "bimanual"
    _state_keys = tuple([f"{side}_{joint}.pos" for side in ("left", "right") for joint in [*[f"joint_{index}" for index in range(1, 8)], "gripper"]])

    def connect(self, calibrate=True):
        if self._connected:
            raise RuntimeError("BiOpenArmFollower is already connected")
        config = {"kind": "bimanual", "side": "bimanual", "cameras": self.config.cameras,
                  "left": _public_config(self.config.left_arm_config), "right": _public_config(self.config.right_arm_config)}
        if config["cameras"] or config["left"].get("cameras") or config["right"].get("cameras"):
            config["cameras"] = config["cameras"] or config["left"].get("cameras") or config["right"].get("cameras")
        _rpc("compat.connect", {"instanceId": self._instance_id, "config": config})
        self._connected = True

    def send_action(self, action, custom_kp=None, custom_kd=None):
        return super().send_action(action, customKp=custom_kp, customKd=custom_kd)


def _install_lerobot():
    _package("lerobot")
    _package("lerobot.robots")
    so = _module("lerobot.robots.so_follower", SOFollower=SOFollower, SO100Follower=SO100Follower,
                 SO101Follower=SO101Follower, SOFollowerConfig=SOFollowerConfig,
                 SOFollowerRobotConfig=SOFollowerRobotConfig, SO100FollowerConfig=SO100FollowerConfig,
                 SO101FollowerConfig=SO101FollowerConfig)
    _module("lerobot.robots.so_follower.config_so_follower", **{name: getattr(so, name) for name in ("SOFollowerConfig", "SOFollowerRobotConfig", "SO100FollowerConfig", "SO101FollowerConfig")})
    _module("lerobot.robots.so_follower.so_follower", SOFollower=SOFollower, SO100Follower=SO100Follower, SO101Follower=SO101Follower)
    lekiwi = _module("lerobot.robots.lekiwi", LeKiwiClient=LeKiwiClient, LeKiwiClientConfig=LeKiwiClientConfig)
    _module("lerobot.robots.lekiwi.config_lekiwi", LeKiwiClientConfig=LeKiwiClientConfig)
    _module("lerobot.robots.lekiwi.lekiwi_client", LeKiwiClient=LeKiwiClient)
    openarm = _module("lerobot.robots.openarm_follower", OpenArmFollower=OpenArmFollower,
                      OpenArmFollowerConfig=OpenArmFollowerConfig, OpenArmFollowerConfigBase=OpenArmFollowerConfigBase)
    _module("lerobot.robots.openarm_follower.config_openarm_follower", OpenArmFollowerConfig=OpenArmFollowerConfig, OpenArmFollowerConfigBase=OpenArmFollowerConfigBase)
    _module("lerobot.robots.openarm_follower.openarm_follower", OpenArmFollower=OpenArmFollower)
    _module("lerobot.robots.bi_openarm_follower", BiOpenArmFollower=BiOpenArmFollower, BiOpenArmFollowerConfig=BiOpenArmFollowerConfig)
    _module("lerobot.robots.bi_openarm_follower.config_bi_openarm_follower", BiOpenArmFollowerConfig=BiOpenArmFollowerConfig)
    _module("lerobot.robots.bi_openarm_follower.bi_openarm_follower", BiOpenArmFollower=BiOpenArmFollower)


class Duration:
    def __init__(self, sec=0, nanosec=0): self.sec, self.nanosec = int(sec), int(nanosec)


class Header:
    def __init__(self): self.stamp, self.frame_id = Duration(), ""


class JointState:
    def __init__(self): self.header, self.name, self.position, self.velocity, self.effort = Header(), [], [], [], []


class Float64MultiArray:
    def __init__(self, data=None): self.data = list(data or [])


class JointTrajectoryPoint:
    def __init__(self): self.positions, self.velocities, self.accelerations, self.effort, self.time_from_start = [], [], [], [], Duration()


class JointTrajectory:
    def __init__(self): self.header, self.joint_names, self.points = Header(), [], []


class FollowJointTrajectory:
    class Goal:
        def __init__(self): self.trajectory = JointTrajectory()
    class Result:
        SUCCESSFUL = 0
        def __init__(self): self.error_code, self.error_string = 0, ""
    class Feedback:
        def __init__(self): self.joint_names, self.desired, self.actual, self.error = [], JointTrajectoryPoint(), JointTrajectoryPoint(), JointTrajectoryPoint()


def _duration_seconds(value):
    return float(getattr(value, "sec", 0)) + float(getattr(value, "nanosec", 0)) / 1_000_000_000


def _message_payload(message):
    if isinstance(message, Float64MultiArray): return {"type": "Float64MultiArray", "data": list(message.data)}
    if isinstance(message, JointTrajectory): return {"type": "JointTrajectory", "jointNames": list(message.joint_names), "points": [{"positions": list(point.positions), "timeFromStart": _duration_seconds(point.time_from_start)} for point in message.points]}
    raise TypeError(f"Unsupported message type: {type(message).__name__}")


class Future:
    def __init__(self): self._done, self._result, self._exception = False, None, None
    def done(self): return self._done
    def result(self):
        if self._exception: raise self._exception
        return self._result
    def exception(self): return self._exception
    def _resolve(self, value): self._result, self._done = value, True
    def _reject(self, error): self._exception, self._done = error, True


class _GoalResult:
    def __init__(self, result): self.status, self.result = 4, result


class _GoalHandle:
    def __init__(self, accepted, result=None, duration=0): self.accepted, self._result, self._duration = bool(accepted), result, float(duration)
    def get_result_async(self):
        future = Future()
        if self.accepted and self._duration > 0: _sim_sleep(self._duration)
        future._resolve(_GoalResult(self._result or FollowJointTrajectory.Result())); return future
    def cancel_goal_async(self):
        future = Future(); future._resolve(types.SimpleNamespace(goals_canceling=[self] if self.accepted else [])); return future


class _Publisher:
    def __init__(self, topic): self.topic = topic
    def publish(self, message): return _rpc("compat.ros.publish", {"topic": self.topic, "message": _message_payload(message)})


class _Subscription:
    def __init__(self, topic, callback): self.topic, self.callback = topic, callback


class Node:
    def __init__(self, node_name, **_kwargs): self.node_name, self._destroyed = str(node_name), False
    def create_publisher(self, msg_type, topic, qos_profile):
        _rpc("compat.ros.create", {"kind": "publisher", "name": str(topic), "messageType": msg_type.__name__})
        return _Publisher(str(topic))
    def create_subscription(self, msg_type, topic, callback, qos_profile):
        _rpc("compat.ros.create", {"kind": "subscription", "name": str(topic), "messageType": msg_type.__name__})
        subscription = _Subscription(str(topic), callback)
        if str(topic) == "/joint_states":
            observation = _rpc("compat.ros.joint_states")
            message = JointState(); message.name, message.position = observation["name"], observation["position"]
            callback(message)
        return subscription
    def destroy_node(self): self._destroyed = True; return True


class ActionClient:
    def __init__(self, node, action_type, action_name):
        self.node, self.action_type, self.action_name = node, action_type, str(action_name)
        _rpc("compat.ros.create", {"kind": "action", "name": self.action_name, "messageType": action_type.__name__})
    def wait_for_server(self, timeout_sec=None): return True
    def send_goal_async(self, goal, feedback_callback=None):
        future = Future()
        try:
            response = _rpc("compat.ros.goal", {"action": self.action_name, "trajectory": _message_payload(goal.trajectory)})
            result = FollowJointTrajectory.Result(); result.error_code, result.error_string = int(response.get("errorCode", 0)), str(response.get("errorString", ""))
            handle = _GoalHandle(response.get("accepted", False), result, response.get("duration", 0)); future._resolve(handle)
            if feedback_callback and handle.accepted:
                feedback_callback(types.SimpleNamespace(feedback=FollowJointTrajectory.Feedback()))
        except Exception as error: future._reject(error)
        return future
    def destroy(self): return None


_rclpy_ok = False


def init(args=None):
    global _rclpy_ok
    _rclpy_ok = True


def shutdown():
    global _rclpy_ok
    _rclpy_ok = False


def ok(): return _rclpy_ok


def spin_once(node, timeout_sec=None):
    if timeout_sec is not None and float(timeout_sec) > 0: _sim_sleep(float(timeout_sec))


def spin_until_future_complete(node, future, timeout_sec=None):
    start = _sim_now()
    while not future.done():
        if timeout_sec is not None and _sim_now() - start >= float(timeout_sec): break
        _sim_sleep(0.02)
    return future


def _install_ros_profile():
    rclpy = _package("rclpy")
    rclpy.init, rclpy.shutdown, rclpy.ok = init, shutdown, ok
    rclpy.spin_once, rclpy.spin_until_future_complete = spin_once, spin_until_future_complete
    _module("rclpy.node", Node=Node)
    _module("rclpy.action", ActionClient=ActionClient)
    _package("sensor_msgs"); _module("sensor_msgs.msg", JointState=JointState)
    _package("std_msgs"); _module("std_msgs.msg", Float64MultiArray=Float64MultiArray)
    _package("trajectory_msgs"); _module("trajectory_msgs.msg", JointTrajectory=JointTrajectory, JointTrajectoryPoint=JointTrajectoryPoint)
    _package("control_msgs"); _module("control_msgs.action", FollowJointTrajectory=FollowJointTrajectory)
    _package("builtin_interfaces"); _module("builtin_interfaces.msg", Duration=Duration)


def _write_external_profiles():
    profiles = json.loads(str(__V2_PROFILE_FILES_JSON__ or "{}"))
    for filename, value in profiles.items():
        safe = str(filename).replace("\\", "/").split("/")[-1]
        if safe not in ("transport.json", "workcell.json"):
            raise ValueError(f"Unsupported external profile filename: {filename}")
        with open(safe, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2)


def run_user_program():
    stdout_buffer, stderr_buffer = io.StringIO(), io.StringIO()
    try:
        if not can_run_sync():
            raise RuntimeError("JSPI synchronous bridge unavailable on this deployment origin; portable Python execution cannot start.")
        _install_simulation_time()
        _install_lerobot()
        _install_ros_profile()
        _write_external_profiles()
        namespace = {"__name__": "__main__", "__file__": "learner_program.py", "__package__": None}
        with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
            exec(compile(str(__V2_USER_CODE__), "learner_program.py", "exec"), namespace, namespace)
        return {"ok": True, "stdout": stdout_buffer.getvalue(), "stderr": stderr_buffer.getvalue(), "error": "", "traceback": ""}
    except BaseException as exc:
        return {"ok": False, "stdout": stdout_buffer.getvalue(), "stderr": stderr_buffer.getvalue(), "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc(limit=12)}


json.dumps(run_user_program())
