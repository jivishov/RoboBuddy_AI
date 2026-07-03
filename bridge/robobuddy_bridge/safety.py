from __future__ import annotations

from typing import Any

LIMITS = {
    "shoulder_pan": (-90, 90),
    "shoulder_lift": (-90, 90),
    "elbow_flex": (-120, 120),
    "wrist_flex": (-90, 90),
    "wrist_roll": (-180, 180),
    "gripper": (0, 100),
}

ALLOWED_TYPES = {"home", "stop", "wait", "move_joint", "move_joints", "set_gripper"}


class ValidationError(ValueError):
    pass


def validate_commands(commands: Any, robot_id: str) -> list[dict[str, Any]]:
    if not isinstance(commands, list):
        raise ValidationError("commands must be a list")
    if len(commands) > 1000:
        raise ValidationError("too many commands")
    return [validate_command(command, index, robot_id) for index, command in enumerate(commands)]


def validate_command(command: Any, index: int, robot_id: str) -> dict[str, Any]:
    if not isinstance(command, dict):
        raise ValidationError(f"command {index + 1} must be an object")
    command_type = str(command.get("type") or "")
    if command_type not in ALLOWED_TYPES:
        raise ValidationError(f"command {index + 1} unsupported type: {command_type}")
    target_robot = str(command.get("robotId") or robot_id)
    if target_robot != robot_id and command_type != "stop":
        raise ValidationError(f"command {index + 1} targets {target_robot}, not {robot_id}")
    if command_type == "move_joint":
        joint = str(command.get("joint") or "")
        value = _joint_value(joint, command.get("value"), index)
        speed = _speed(command.get("speed", 50), index)
        return {**command, "robotId": robot_id, "joint": joint, "value": value, "speed": speed}
    if command_type == "move_joints":
        raw_joints = command.get("joints")
        if not isinstance(raw_joints, dict) or not raw_joints:
            raise ValidationError(f"command {index + 1} move_joints requires joints")
        joints = {str(joint): _joint_value(str(joint), value, index) for joint, value in raw_joints.items()}
        return {**command, "robotId": robot_id, "joints": joints, "speed": _speed(command.get("speed", 50), index)}
    if command_type == "set_gripper":
        value = command.get("value")
        if value == "open":
            value = 20
        elif value in ("close", "closed"):
            value = 85
        return {**command, "robotId": robot_id, "value": _joint_value("gripper", value, index), "speed": _speed(command.get("speed", 50), index)}
    if command_type == "wait":
        seconds = _number(command.get("seconds"), f"command {index + 1} seconds")
        if seconds < 0 or seconds > 30:
            raise ValidationError(f"command {index + 1} wait seconds must be 0..30")
        return {**command, "robotId": robot_id, "seconds": seconds}
    return {**command, "robotId": robot_id}


def _joint_value(joint: str, value: Any, index: int) -> float:
    if joint not in LIMITS:
        raise ValidationError(f"command {index + 1} unknown joint: {joint}")
    low, high = LIMITS[joint]
    number = _number(value, f"command {index + 1} {joint}")
    if number < low or number > high:
        raise ValidationError(f"command {index + 1} {joint} must be {low}..{high}")
    return number


def _speed(value: Any, index: int) -> int:
    number = int(round(_number(value, f"command {index + 1} speed")))
    if number < 1 or number > 100:
        raise ValidationError(f"command {index + 1} speed must be 1..100")
    return number


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise ValidationError(f"{label} must be a number")
    try:
        return float(value)
    except Exception as exc:
        raise ValidationError(f"{label} must be a number") from exc
