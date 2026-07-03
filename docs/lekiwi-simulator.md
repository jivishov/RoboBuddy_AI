# LeKiwi Simulator

Robot id: `lekiwi_sim`.

Tier 1 includes a simple LeKiwi-style mobile manipulator simulator. It supports:

- holonomic base pose `x`, `y`, `theta`
- `drive` commands using `vx`, `vy`, `omega`, and `seconds`
- arm joint controls, including wrist roll
- gripper controls
- official URDF/STL-derived 3D mesh preview with primitive fallback
- Home and STOP

No real LeKiwi hardware mode is exposed in Tier 1.
