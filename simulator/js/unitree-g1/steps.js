import { advanceRoot, normalizeDegrees, secondsPerStep } from "./calculations.js?v=20260812-g1-registration-fix-2";

export const G1_NEUTRAL_LEGS = Object.freeze({
  left_hip_pitch_joint: 0,
  left_hip_roll_joint: 0,
  left_hip_yaw_joint: 0,
  left_knee_joint: 0,
  left_ankle_pitch_joint: 0,
  left_ankle_roll_joint: 0,
  right_hip_pitch_joint: 0,
  right_hip_roll_joint: 0,
  right_hip_yaw_joint: 0,
  right_knee_joint: 0,
  right_ankle_pitch_joint: 0,
  right_ankle_roll_joint: 0,
  waist_yaw_joint: 0,
  waist_roll_joint: 0,
  waist_pitch_joint: 0
});

export const G1_CARRY_ARMS = Object.freeze({
  left_shoulder_pitch_joint: -35,
  left_shoulder_roll_joint: -18,
  left_shoulder_yaw_joint: 0,
  left_elbow_joint: 82,
  left_wrist_roll_joint: 0,
  left_wrist_pitch_joint: 12,
  left_wrist_yaw_joint: -12,
  right_shoulder_pitch_joint: -35,
  right_shoulder_roll_joint: 18,
  right_shoulder_yaw_joint: 0,
  right_elbow_joint: 82,
  right_wrist_roll_joint: 0,
  right_wrist_pitch_joint: 12,
  right_wrist_yaw_joint: 12
});

export function gaitPose(leftLead, carry = false) {
  const pose = {
    left_hip_pitch_joint: leftLead ? -24 : 16,
    left_knee_joint: leftLead ? 30 : 10,
    left_ankle_pitch_joint: leftLead ? -10 : -4,
    right_hip_pitch_joint: leftLead ? 16 : -24,
    right_knee_joint: leftLead ? 10 : 30,
    right_ankle_pitch_joint: leftLead ? -4 : -10,
    left_hip_roll_joint: leftLead ? 2 : -2,
    right_hip_roll_joint: leftLead ? 2 : -2,
    waist_yaw_joint: leftLead ? -4 : 4
  };
  return carry
    ? { ...pose, ...G1_CARRY_ARMS }
    : {
        ...pose,
        left_shoulder_pitch_joint: leftLead ? 18 : -18,
        right_shoulder_pitch_joint: leftLead ? -18 : 18,
        left_elbow_joint: 8,
        right_elbow_joint: 8
      };
}

export function createWalkKeyframes(command, startState) {
  const direction = command.direction === "backward" ? -1 : 1;
  const count = Math.max(1, Math.round(Number(command.steps) || 1));
  const stepLength = Math.abs(Number(command.stepLengthM) || 0.08) * direction;
  const seconds = secondsPerStep(command.speed);
  let root = { ...(startState.humanoidRoot || { x: 0, z: 0, theta: 0 }) };
  const keyframes = [{ at: 0, root, joints: { ...(startState.joints || {}) }, label: "Starting step sequence" }];
  for (let index = 0; index < count; index += 1) {
    root = advanceRoot(root, stepLength, root.theta);
    keyframes.push({
      at: (index + 1) / (count + 1),
      root,
      joints: { ...(startState.joints || {}), ...gaitPose(index % 2 === 0, false) },
      label: `${direction > 0 ? "Forward" : "Backward"} step ${index + 1} of ${count}`
    });
  }
  keyframes.push({
    at: 1,
    root,
    joints: { ...(startState.joints || {}), ...G1_NEUTRAL_LEGS },
    label: "Step sequence complete"
  });
  return { keyframes, durationSeconds: seconds * count };
}

export function createTurnKeyframes(command, startState) {
  const root = { ...(startState.humanoidRoot || { x: 0, z: 0, theta: 0 }) };
  const angle = Number(command.angleDeg) || 0;
  const half = normalizeDegrees(root.theta + angle / 2);
  const final = normalizeDegrees(root.theta + angle);
  return {
    durationSeconds: Number(command.seconds) || 1.5,
    keyframes: [
      { at: 0, root, joints: { ...(startState.joints || {}) }, label: "Preparing turn" },
      {
        at: 0.5,
        root: { ...root, theta: half },
        joints: {
          ...(startState.joints || {}),
          left_knee_joint: 14,
          right_knee_joint: 14,
          left_hip_yaw_joint: angle >= 0 ? -22 : 22,
          right_hip_yaw_joint: angle >= 0 ? 22 : -22,
          left_ankle_pitch_joint: -5,
          right_ankle_pitch_joint: -5
        },
        label: "Turning"
      },
      {
        at: 1,
        root: { ...root, theta: final },
        joints: { ...(startState.joints || {}), ...G1_NEUTRAL_LEGS },
        label: "Turn complete"
      }
    ]
  };
}

export function createDemoKeyframes(startState) {
  const startRoot = { ...(startState.humanoidRoot || { x: 0, z: 0, theta: 0 }) };
  const baseJoints = { ...(startState.joints || {}) };
  const keyframes = [{ at: 0, root: startRoot, joints: baseJoints, label: "Starting demonstration" }];
  let root = { ...startRoot };
  for (let index = 0; index < 5; index += 1) {
    root = advanceRoot(root, 0.11, startRoot.theta);
    keyframes.push({ at: 0.05 + index * 0.055, root, joints: { ...baseJoints, ...gaitPose(index % 2 === 0) }, label: `Outbound step ${index + 1} of 5` });
  }
  keyframes.push({
    at: 0.38,
    root,
    joints: {
      ...baseJoints,
      left_hip_pitch_joint: -60,
      right_hip_pitch_joint: -60,
      left_knee_joint: 22,
      right_knee_joint: 22,
      left_ankle_pitch_joint: -8,
      right_ankle_pitch_joint: -8,
      waist_pitch_joint: 29.7938,
      left_shoulder_pitch_joint: -90,
      left_shoulder_roll_joint: -14,
      left_elbow_joint: 14,
      right_shoulder_pitch_joint: -90,
      right_shoulder_roll_joint: 14,
      right_elbow_joint: 14
    },
    label: "Bending to the pickup point"
  });
  keyframes.push({ at: 0.49, root, joints: { ...baseJoints, ...G1_CARRY_ARMS }, label: "Attaching the nearby tool", event: "pick_right" });
  keyframes.push({ at: 0.6, root, joints: { ...baseJoints, ...G1_NEUTRAL_LEGS, ...G1_CARRY_ARMS }, label: "Standing with the tool" });
  keyframes.push({ at: 0.68, root: { ...root, theta: normalizeDegrees(startRoot.theta + 180) }, joints: { ...baseJoints, ...G1_CARRY_ARMS }, label: "Turning around" });
  for (let index = 0; index < 5; index += 1) {
    root = advanceRoot(root, -0.11, startRoot.theta);
    keyframes.push({ at: 0.72 + index * 0.05, root: { ...root, theta: normalizeDegrees(startRoot.theta + 180) }, joints: { ...baseJoints, ...gaitPose(index % 2 === 0, true) }, label: `Return step ${index + 1} of 5` });
  }
  keyframes.push({
    at: 1,
    root: { ...startRoot, theta: normalizeDegrees(startRoot.theta + 180) },
    joints: { ...baseJoints, ...G1_NEUTRAL_LEGS, ...G1_CARRY_ARMS },
    label: "Returned with the tool"
  });
  return { keyframes, durationSeconds: 11.5 };
}
