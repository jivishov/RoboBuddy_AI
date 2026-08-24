import { deepClone, deepFreeze } from "./math.js";
import { SO101_COMMAND_MODEL } from "./so101-command-model.js";

export const PYTHON_COMPATIBILITY_CATALOG_SCHEMA = "robobuddy.python-compatibility-catalog.v1";
export const PYTHON_COMPATIBILITY_CLAIM = "API-compatible browser simulation with reference-calibrated kinematics. Hardware validation pending.";

const LEROBOT_REVISION = "7e241bd630a3719a56157a497ce5d08f244784f1";
const LEKIWI_GEOMETRY_REVISION = "efa608d7ee5a495a4803b1d28cd0c955b4f1e033";
const OPENARM_ROS2_REVISION = "73ef89838763496b94da30ede38fc92218bea18e";
const OPENARM_DESCRIPTION_REVISION = "6c7b720f1ba48e8bafa3a3dc752c45f397b42221";

const configuredResponse = (velocity, acceleration, unit) => ({
  velocity: { value: velocity, unit: `${unit}/s`, provenance: "configured", note: "Browser response bound; not a motor or controller specification." },
  acceleration: { value: acceleration, unit: `${unit}/s^2`, provenance: "configured", note: "Browser response bound; upstream acceleration behavior is not emulated." },
});

const commonNotSimulated = Object.freeze([
  "motor, firmware, controller-loop, inertia, gravity-load, friction, compliance, backlash, thermal, current, and voltage dynamics",
  "payload certification, grasp stability, force or torque sensing/control, collision recovery, wear, damage, and safety certification",
  "physical calibration, calibration transfer, serial, CAN, ZMQ, sockets, threads, devices, networks, and hardware setup",
  "cameras, datasets, policies, training, and undocumented device behavior",
]);

const so101Fields = Object.freeze(SO101_COMMAND_MODEL.fields.map((field) => ({
  key: field.actionKey,
  jointId: field.jointId,
  unit: field.unit === "normalized_0_100" ? "normalized_0_100" : "deg",
  minimum: field.min,
  maximum: field.max,
  limitProvenance: field.rangeBasis,
  response: configuredResponse(field.jointId === "gripper" ? 120 : 180, field.jointId === "gripper" ? 480 : 720, field.jointId === "gripper" ? "normalized" : "deg"),
})));

const lekiwiKeys = Object.freeze([
  "arm_shoulder_pan.pos", "arm_shoulder_lift.pos", "arm_elbow_flex.pos",
  "arm_wrist_flex.pos", "arm_wrist_roll.pos", "arm_gripper.pos",
  "x.vel", "y.vel", "theta.vel",
]);

const openArmMotors = Object.freeze(["joint_1", "joint_2", "joint_3", "joint_4", "joint_5", "joint_6", "joint_7", "gripper"]);
const openArmLeftLimits = Object.freeze({
  joint_1: [-75, 75], joint_2: [-90, 9], joint_3: [-85, 85], joint_4: [0, 135],
  joint_5: [-85, 85], joint_6: [-40, 40], joint_7: [-80, 80], gripper: [-65, 0],
});
const openArmRightLimits = Object.freeze({
  joint_1: [-75, 75], joint_2: [-9, 90], joint_3: [-85, 85], joint_4: [0, 135],
  joint_5: [-85, 85], joint_6: [-40, 40], joint_7: [-80, 80], gripper: [-65, 0],
});

const openArmRosJoints = Object.freeze({
  single: Object.freeze(Array.from({ length: 7 }, (_, index) => `openarm_joint${index + 1}`)),
  left: Object.freeze(Array.from({ length: 7 }, (_, index) => `openarm_left_joint${index + 1}`)),
  right: Object.freeze(Array.from({ length: 7 }, (_, index) => `openarm_right_joint${index + 1}`)),
  singleGripper: Object.freeze(["openarm_finger_joint1"]),
  leftGripper: Object.freeze(["openarm_left_finger_joint1"]),
  rightGripper: Object.freeze(["openarm_right_finger_joint1"]),
});

const CATALOG = {
  schema: PYTHON_COMPATIBILITY_CATALOG_SCHEMA,
  version: 1,
  claim: PYTHON_COMPATIBILITY_CLAIM,
  axes: {
    pythonSourceCompatibility: "Pinned public imports, configurations, methods, fields, units, return shapes, source patterns, and explicit failures.",
    digitalModelFidelity: "Independently pinned geometry/frames/limits plus explicitly configured kinematic response values.",
  },
  runtime: {
    pyodide: "0.29.4",
    execution: "whole synchronous script with __name__ == '__main__' under runPythonAsync plus JSPI run_sync",
    tickSeconds: 0.02,
    timeScale: 1,
    time: { sleep: "simulation", monotonic: "simulation", perfCounter: "simulation", wallClockTime: "wall" },
    pauseBoundary: "Cooperative at compatibility bridge calls, patched sleeps, and supported ROS futures.",
  },
  profiles: {
    so101: {
      robotId: "so101_follower",
      label: "SO-101 LeRobot 0.6.1 compatibility profile",
      imports: ["lerobot.robots.so_follower.SO101Follower", "lerobot.robots.so_follower.SO101FollowerConfig"],
      apiSource: {
        kind: "referenced", revision: LEROBOT_REVISION, license: "Apache-2.0", version: "0.6.1",
        robotUrl: `https://github.com/huggingface/lerobot/blob/${LEROBOT_REVISION}/src/lerobot/robots/so_follower/so_follower.py`,
        configUrl: `https://github.com/huggingface/lerobot/blob/${LEROBOT_REVISION}/src/lerobot/robots/so_follower/config_so_follower.py`,
      },
      geometrySource: {
        kind: "referenced", revision: SO101_COMMAND_MODEL.sources.urdf.revision, license: "Apache-2.0",
        url: SO101_COMMAND_MODEL.sources.urdf.url, units: "URDF metres/radians; browser render boundary millimetres/degrees",
      },
      controlSource: { kind: "configured", revision: "robobuddy.portable-plant.v1", tickSeconds: 0.02, note: "Kinematic response only; not Feetech/controller emulation." },
      config: {
        required: ["port"],
        defaults: { id: null, calibration_dir: null, disable_torque_on_disconnect: true, max_relative_target: null, cameras: {}, use_degrees: true, position_p_coefficient: 16, position_i_coefficient: 0, position_d_coefficient: 32, num_read_retries: 2 },
      },
      actionFields: so101Fields,
      observationFields: so101Fields,
      clipping: "Only max_relative_target when configured; relative to live actual position, matching ensure_safe_goal_position. Browser joint-envelope rejection is a simulator fault boundary, not upstream clipping.",
      publicReturn: "send_action returns the supplied recognized .pos subset after optional max_relative_target clipping; get_observation returns the six live .pos values.",
      frames: { base: "official URDF root", tool: SO101_COMMAND_MODEL.gripper.toolFrameNode },
      rendererMap: Object.fromEntries(so101Fields.map((field) => [field.key, field.jointId])),
      unsupportedCapabilities: [...commonNotSimulated, "native Cartesian or IK SOFollower command", "automatic collision avoidance"],
    },
    lekiwi: {
      robotId: "lekiwi_sim",
      label: "LeKiwi LeRobot 0.6.1 client compatibility profile",
      imports: ["lerobot.robots.lekiwi.LeKiwiClient", "lerobot.robots.lekiwi.LeKiwiClientConfig"],
      apiSource: {
        kind: "referenced", revision: LEROBOT_REVISION, license: "Apache-2.0", version: "0.6.1",
        robotUrl: `https://github.com/huggingface/lerobot/blob/${LEROBOT_REVISION}/src/lerobot/robots/lekiwi/lekiwi_client.py`,
        configUrl: `https://github.com/huggingface/lerobot/blob/${LEROBOT_REVISION}/src/lerobot/robots/lekiwi/config_lekiwi.py`,
      },
      geometrySource: {
        kind: "referenced", revision: LEKIWI_GEOMETRY_REVISION, license: "Apache-2.0",
        url: `https://github.com/SIGRobotics-UIUC/LeKiwi/blob/${LEKIWI_GEOMETRY_REVISION}/URDF/LeKiwi.urdf`,
        urdfSha256: "47887649403f212ee2853850a01affe1e36aff454aa1998d5265ac4ac2d5a49d",
        units: "URDF metres/radians; browser render boundary millimetres/degrees",
      },
      controlSource: {
        kind: "mixed", revision: LEROBOT_REVISION, watchdogMs: 500,
        frames: "+X forward, +Y left, +Z up, positive yaw counter-clockwise",
        externalUnits: { "x.vel": "m/s", "y.vel": "m/s", "theta.vel": "deg/s" }, internalAngularUnit: "rad/s",
        response: { arm: configuredResponse(180, 720, "deg"), baseLinearAcceleration: { value: 0.8, unit: "m/s^2", provenance: "configured" }, baseAngularAcceleration: { value: 240, unit: "deg/s^2", provenance: "configured" } },
      },
      config: {
        required: ["remote_ip"],
        defaults: { id: null, calibration_dir: null, port_zmq_cmd: 5555, port_zmq_observations: 5556, polling_timeout_ms: 15, connect_timeout_s: 5, cameras: "official lekiwi_cameras_config() (rejected in browser; pass cameras={})" },
      },
      stateOrder: lekiwiKeys,
      actionFields: lekiwiKeys.map((key) => ({ key, unit: key === "theta.vel" ? "deg/s" : key.endsWith(".vel") ? "m/s" : key === "arm_gripper.pos" ? "normalized_0_100" : "deg" })),
      publicReturn: "send_action returns all nine ordered state fields plus ACTION ('action') as a float32 NumPy vector; omitted fields are zero, matching LeKiwiClient 0.6.1.",
      rendererMap: { "arm_shoulder_pan.pos": "shoulder_pan", "arm_shoulder_lift.pos": "shoulder_lift", "arm_elbow_flex.pos": "elbow_flex", "arm_wrist_flex.pos": "wrist_flex", "arm_wrist_roll.pos": "wrist_roll", "arm_gripper.pos": "gripper" },
      safetyPolicy: "Stow-before-drive is visible scenario/grading policy only. It is never an automatic plant action.",
      unsupportedCapabilities: [...commonNotSimulated, "LeKiwi ZMQ host/client transport", "wheel slip, odometry error, SLAM, and contact dynamics", "hidden automatic stow"],
    },
    openarm: {
      robotId: "openarm_v2_bimanual",
      label: "OpenArm LeRobot 0.6.1 plus OpenArm ROS 2 source-pattern compatibility profiles",
      apiSource: {
        kind: "referenced", revision: LEROBOT_REVISION, license: "Apache-2.0", version: "0.6.1",
        robotUrl: `https://github.com/huggingface/lerobot/blob/${LEROBOT_REVISION}/src/lerobot/robots/openarm_follower/openarm_follower.py`,
        configUrl: `https://github.com/huggingface/lerobot/blob/${LEROBOT_REVISION}/src/lerobot/robots/openarm_follower/config_openarm_follower.py`,
        bimanualUrl: `https://github.com/huggingface/lerobot/blob/${LEROBOT_REVISION}/src/lerobot/robots/bi_openarm_follower/bi_openarm_follower.py`,
      },
      geometrySource: {
        kind: "referenced", revision: OPENARM_DESCRIPTION_REVISION, license: "Apache-2.0",
        url: `https://github.com/enactic/openarm_description/tree/${OPENARM_DESCRIPTION_REVISION}`,
        morphology: "physical OpenArm v1 left/right arm and bimanual description meshes",
      },
      simulatorSpecificMorphology: {
        kind: "configured", id: "openarm_v2_bimanual_550mm_turntable", standHeightMm: 550,
        note: "RoboBuddy-only stand and turntable; separate from physical OpenArm v1 and never exposed as hardware behavior.",
      },
      controlSource: {
        kind: "referenced", revision: OPENARM_ROS2_REVISION, tag: "0.9.2", distribution: "Humble", license: "Apache-2.0",
        url: `https://github.com/enactic/openarm_ros2/tree/${OPENARM_ROS2_REVISION}`,
        controllerUpdateRateHz: 100, statePublishRateHz: 50, actionMonitorRateHz: 50,
        accelerationProvenance: "OpenArm 0.9.2 joint_limits.yaml declares acceleration limits disabled; browser acceleration response is configured and not source-claimed.",
      },
      lerobot: {
        imports: ["lerobot.robots.openarm_follower.OpenArmFollower", "lerobot.robots.openarm_follower.OpenArmFollowerConfig", "lerobot.robots.bi_openarm_follower.BiOpenArmFollower", "lerobot.robots.bi_openarm_follower.BiOpenArmFollowerConfig"],
        motors: openArmMotors,
        leftLimitsDeg: openArmLeftLimits,
        rightLimitsDeg: openArmRightLimits,
        configDefaults: { side: null, can_interface: "socketcan", use_can_fd: true, can_bitrate: 1000000, can_data_bitrate: 5000000, disable_torque_on_disconnect: true, use_velocity_and_torque: false, max_relative_target: null, cameras: {}, position_kp: [240, 240, 240, 240, 24, 31, 25, 25], position_kd: [5, 5, 3, 5, 0.3, 0.3, 0.3, 0.3] },
        clipping: "Per-side joint-limit clipping followed by optional max_relative_target clipping. custom_kp/custom_kd are rejected because custom hardware gains are unsupported.",
      },
      ros2SourcePatternProfile: {
        exactLabel: "OpenArm ROS 2 source-pattern compatibility profile",
        disclaimer: "Not ROS 2 in the browser: no DDS, ROS graph, launch, TF, parameters, services, MoveIt, or real QoS/timing.",
        functions: ["rclpy.init", "rclpy.shutdown", "rclpy.ok", "rclpy.spin_once", "rclpy.spin_until_future_complete"],
        node: ["Node", "create_publisher", "create_subscription"],
        action: ["ActionClient"],
        messages: ["sensor_msgs/JointState", "std_msgs/Float64MultiArray", "trajectory_msgs/JointTrajectory", "trajectory_msgs/JointTrajectoryPoint", "control_msgs/FollowJointTrajectory"],
        joints: openArmRosJoints,
        topics: ["/joint_states", "/forward_position_controller/commands", "/left_forward_position_controller/commands", "/right_forward_position_controller/commands"],
        actions: ["/joint_trajectory_controller/follow_joint_trajectory", "/left_joint_trajectory_controller/follow_joint_trajectory", "/right_joint_trajectory_controller/follow_joint_trajectory", "/gripper_controller/follow_joint_trajectory", "/left_gripper_controller/follow_joint_trajectory", "/right_gripper_controller/follow_joint_trajectory"],
        rules: ["radians", "complete exact joint list", "strictly monotonic time_from_start", "goal/reject/feedback/result/cancel futures"],
      },
      rendererMap: {
        single: Object.fromEntries(openArmMotors.map((motor, index) => [`${motor}.pos`, index === 7 ? "left_gripper" : `left_j${index + 1}`])),
        left: Object.fromEntries(openArmMotors.map((motor, index) => [`left_${motor}.pos`, index === 7 ? "left_gripper" : `left_j${index + 1}`])),
        right: Object.fromEntries(openArmMotors.map((motor, index) => [`right_${motor}.pos`, index === 7 ? "right_gripper" : `right_j${index + 1}`])),
      },
      configuredResponse: configuredResponse(120, 480, "deg"),
      unsupportedCapabilities: [...commonNotSimulated, "velocity and torque control", "custom hardware gains", "DDS, ROS graph, launch, TF, parameters, services, MoveIt, and real QoS/timing", "physical stand or turntable equivalence"],
    },
  },
};

export const PYTHON_COMPATIBILITY_CATALOG = deepFreeze(CATALOG);

export function compatibilityProfile(robotId) {
  const profile = Object.values(PYTHON_COMPATIBILITY_CATALOG.profiles).find((candidate) => candidate.robotId === robotId);
  if (!profile) throw new Error(`No portable Python compatibility profile for ${robotId}.`);
  return deepClone(profile);
}
