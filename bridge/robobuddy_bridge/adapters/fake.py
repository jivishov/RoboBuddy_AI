from __future__ import annotations

from typing import Any

from .base import BaseAdapter
from ..models import STATUS_CONNECTED, STATUS_EXECUTING


class FakeAdapter(BaseAdapter):
    def connect(self, options: dict[str, Any]) -> dict[str, Any]:
        result = super().connect(options)
        self.state.calibrated = True
        self.state.status = STATUS_CONNECTED
        return {**result, "status": self.state.status, "calibrated": True}

    def execute(self, commands: list[dict[str, Any]]) -> dict[str, Any]:
        self.state.connected = True
        self.state.calibrated = True
        self.state.status = STATUS_EXECUTING
        self.state.last_commands = commands
        return self.state.to_dict()
