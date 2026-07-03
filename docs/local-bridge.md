# Local Bridge

SO-101 hardware is never controlled directly by the browser. The frontend talks to a local bridge bound to `127.0.0.1:8765` by default.

Run:

```powershell
cd bridge
python -m robobuddy_bridge
```

Endpoints:

- `GET /health`
- `GET /robots`
- `GET /robots/{robot_id}/state`
- `POST /robots/{robot_id}/connect`
- `POST /robots/{robot_id}/disconnect`
- `POST /robots/{robot_id}/home`
- `POST /robots/{robot_id}/stop`
- `POST /robots/{robot_id}/execute`

The bridge accepts only validated RoboBuddy command JSON. It does not accept arbitrary Python from the frontend.

Statuses include `READY`, `DISCONNECTED`, `CONNECTED`, `NEEDS_CALIBRATION`, `EXECUTING`, `STOPPED`, `ERROR`, and `LEROBOT_NOT_INSTALLED`.

Known limitation: the standard-library bridge returns HTTP `426` for the telemetry WebSocket placeholder. Movement, STOP, state, health, and fake-adapter development flows are implemented.
