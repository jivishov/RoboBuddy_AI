# Unitree G1 29-DoF simulator

RoboBuddy integrates the Unitree G1 29-DoF fixed-hand model as the `unitree_g1_29dof` simulation pack. The browser chooser exposes it alongside the Arduino arm, SO-101 follower, LeKiwi, and OpenArm packs.

## Geometry and kinematics

- 29 independently programmable revolute joints: 12 leg, 3 waist, and 14 arm/wrist joints.
- 36 locally bundled visual mesh instances baked from the pinned official Unitree description.
- Source repository: `unitreerobotics/unitree_ros` at revision `dd4fa6866e523ad61324f658d63736e4eda3a6e4`.
- Source description: `robots/g1_description/g1_29dof.urdf` and `robots/g1_description/meshes/`.
- License: BSD-3-Clause; the retained text is in `docs/licenses/unitree_ros-BSD-3-Clause.txt`.

The generated mesh module is `simulator/js/robot-mesh-data-unitree-g1.js`. Rebuild it with:

```powershell
python tools/build-robot-rig-mesh-data.py --robot unitree_g1
```

The builder checks the expected 29 active joints, 36 visual parts, and 36 unique mesh files before writing output.

## Joint identifiers

- Left leg: `left_hip_pitch_joint`, `left_hip_roll_joint`, `left_hip_yaw_joint`, `left_knee_joint`, `left_ankle_pitch_joint`, `left_ankle_roll_joint`.
- Right leg: `right_hip_pitch_joint`, `right_hip_roll_joint`, `right_hip_yaw_joint`, `right_knee_joint`, `right_ankle_pitch_joint`, `right_ankle_roll_joint`.
- Waist: `waist_yaw_joint`, `waist_roll_joint`, `waist_pitch_joint`.
- Left arm and wrist: `left_shoulder_pitch_joint`, `left_shoulder_roll_joint`, `left_shoulder_yaw_joint`, `left_elbow_joint`, `left_wrist_roll_joint`, `left_wrist_pitch_joint`, `left_wrist_yaw_joint`.
- Right arm and wrist: `right_shoulder_pitch_joint`, `right_shoulder_roll_joint`, `right_shoulder_yaw_joint`, `right_elbow_joint`, `right_wrist_roll_joint`, `right_wrist_pitch_joint`, `right_wrist_yaw_joint`.

The manifest is the authority for each degree range. Manual controls, Blockly, Python, and Gemini-generated plans all use the same central validation path.

## Programming

Blockly provides one-joint movement, a scalable named-joint pose block, five posture and humanoid action blocks, STOP, and flow control. The scalable pose design avoids an unusable 29-field block.

Python supports the common `robot.move_joint(...)`, `robot.move_joints(...)`, `robot.smooth_move(...)`, `robot.home()`, and `robot.stop()` methods plus:

```python
robot.set_posture("wide_stance", seconds=0.8)
robot.walk("forward", steps=3, step_length=0.08, speed=45)
robot.turn(90, seconds=1.2)
robot.pick_nearest("right_hand")
robot.release("right_hand")
robot.run_demo()
```

All values are validated against the active manifest. Programs use finite durations and remain interruptible through the normal RoboBuddy STOP path. The main page also exposes grouped sliders for every joint and compact controls for postures, three-step motion, 90-degree turns, fixed-hand interaction, and the full demonstration.

## Simulation boundary

This integration is a scripted kinematic visualization. It does not implement rigid-body dynamics, balance control, contact-aware foot placement, collision avoidance, torque control, motion planning, or verified hardware control. Walk and turn commands animate finite authored keyframes while moving a planar visual root. The rubber hands have no finger joints; pickup is a proximity-tested attachment to a fixed hand tool frame. The full demo uses its authored validation attachment event.

No network is required for the G1 geometry after checkout. Camera orbit/pan and zoom can each be disabled from the 3D toolbar, and Camera restores the default view.
