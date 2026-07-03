# Robots

RoboBuddy Tier 1 ships three robot manifests.

`arduino_arm` is the default and preserves the existing six-servo Arduino arm, Web Serial flow, teach mode, Blockly, Python, Home, and STOP behavior.

`so101_follower` is a simulation-first LeRobot SO-101 follower arm pack. Hardware control requires the optional local bridge at `http://127.0.0.1:8765`, calibration, and an explicit safety confirmation.

`lekiwi_sim` is a simulation-only mobile manipulator pack. It exposes holonomic drive commands plus arm and gripper commands, backed by an official URDF/STL-derived 3D mesh preview with primitive fallback. No real LeKiwi hardware control is included in Tier 1.

Not implemented in Tier 1: drones, quadrupeds, dexterous hands, humanoids, Open Duck Mini, ToddlerBot, full XLeRobot, SO-101 leader/follower teleoperation, cloud direct hardware control, or LeKiwi real hardware.
