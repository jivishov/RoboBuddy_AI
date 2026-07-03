from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


STATUS_BRIDGE_OFFLINE = "BRIDGE_OFFLINE"
STATUS_READY = "READY"
STATUS_DISCONNECTED = "DISCONNECTED"
STATUS_CONNECTED = "CONNECTED"
STATUS_NEEDS_CALIBRATION = "NEEDS_CALIBRATION"
STATUS_EXECUTING = "EXECUTING"
STATUS_STOPPED = "STOPPED"
STATUS_ERROR = "ERROR"
STATUS_LEROBOT_NOT_INSTALLED = "LEROBOT_NOT_INSTALLED"


@dataclass
class BridgeState:
    robot_id: str
    status: str = STATUS_DISCONNECTED
    connected: bool = False
    calibrated: bool = False
    dry_run: bool = True
    last_error: str = ""
    last_commands: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "robotId": self.robot_id,
            "status": self.status,
            "connected": self.connected,
            "calibrated": self.calibrated,
            "dryRun": self.dry_run,
            "lastError": self.last_error,
            "lastCommands": self.last_commands,
        }
