from __future__ import annotations

from typing import Any

from .base import BaseAdapter
from ..models import STATUS_LEROBOT_NOT_INSTALLED, STATUS_NEEDS_CALIBRATION


class SO101LeRobotAdapter(BaseAdapter):
    def _load_lerobot(self):
        try:
            import lerobot  # type: ignore
        except Exception as exc:
            raise RuntimeError("LEROBOT_NOT_INSTALLED: install LeRobot in the local bridge environment") from exc
        return lerobot

    def connect(self, options: dict[str, Any]) -> dict[str, Any]:
        try:
            self._load_lerobot()
        except RuntimeError as exc:
            self.state.status = STATUS_LEROBOT_NOT_INSTALLED
            self.state.last_error = str(exc)
            return self.state.to_dict()
        result = super().connect(options)
        self.state.calibrated = bool(options.get("calibrated", False))
        if not self.state.calibrated:
            self.state.status = STATUS_NEEDS_CALIBRATION
        return {**result, "status": self.state.status, "calibrated": self.state.calibrated}

    def execute(self, commands: list[dict[str, Any]]) -> dict[str, Any]:
        try:
            self._load_lerobot()
        except RuntimeError as exc:
            self.state.status = STATUS_LEROBOT_NOT_INSTALLED
            self.state.last_error = str(exc)
            return self.state.to_dict()
        if not self.state.calibrated:
            self.state.status = STATUS_NEEDS_CALIBRATION
            self.state.last_error = "NEEDS_CALIBRATION: refusing real movement until calibration is verified"
            return self.state.to_dict()
        return super().execute(commands)
