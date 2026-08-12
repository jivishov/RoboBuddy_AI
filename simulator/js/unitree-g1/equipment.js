export const G1_TOOL_FRAMES = Object.freeze({
  left_hand: Object.freeze({ id: "left_hand", group: "left_wrist_yaw_joint", offsetMm: [131.5, 0, -3] }),
  right_hand: Object.freeze({ id: "right_hand", group: "right_wrist_yaw_joint", offsetMm: [131.5, 0, 3] })
});

export const G1_HAND_IDS = Object.freeze(Object.keys(G1_TOOL_FRAMES));
