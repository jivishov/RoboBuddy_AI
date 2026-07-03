from __future__ import annotations

from typing import Any

from ..models import BridgeState, STATUS_CONNECTED, STATUS_DISCONNECTED, STATUS_STOPPED


class BaseAdapter:
    def __init__(self, robot_id: str):
        self.state = BridgeState(robot_id=robot_id)

    def connect(self, options: dict[str, Any]) -> dict[str, Any]:
        self.state.connected = True
        self.state.status = STATUS_CONNECTED
        self.state.dry_run = bool(options.get("dryRun", True))
        return self.state.to_dict()

    def disconnect(self) -> dict[str, Any]:
        self.state.connected = False
        self.state.status = STATUS_DISCONNECTED
        return self.state.to_dict()

    def get_state(self) -> dict[str, Any]:
        return self.state.to_dict()

    def home(self) -> dict[str, Any]:
        self.state.last_commands = [{"type": "home", "robotId": self.state.robot_id}]
        return self.state.to_dict()

    def stop(self) -> dict[str, Any]:
        self.state.status = STATUS_STOPPED
        self.state.last_commands = [{"type": "stop", "robotId": self.state.robot_id, "reason": "user"}]
        return self.state.to_dict()

    def execute(self, commands: list[dict[str, Any]]) -> dict[str, Any]:
        self.state.last_commands = commands
        return self.state.to_dict()
