export const ROBOT_LABELS = Object.freeze({
  arduino_arm: "Arduino Arm",
  so101_follower: "SO-101 Follower",
  lekiwi_sim: "LeKiwi",
  openarm_v2_bimanual: "OpenArm V2 Bimanual",
  unitree_g1_29dof: "Unitree G1"
});

export const PROVENANCE_LABELS = Object.freeze({
  configured: "Configured",
  "simulator-generated": "Simulated",
  "learner-recorded": "Learner recorded",
  calculated: "Calculated",
  extrapolated: "Extrapolated"
});

export const EVIDENCE_BASIS_LABELS = Object.freeze({
  M: "Manual/source-stated",
  F: "Figure/table-supported",
  R: "Real-life implicit",
  C: "Configuration choice",
  "M/R": "Source action assigned to robot morphology"
});

export function labelFromId(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function commandLabel(command) {
  const target = command.objectId || command.controlId || command.instrumentId || command.fieldId || command.poseId || command.joint || "";
  return `${labelFromId(command.type)}${target ? ` · ${labelFromId(target)}` : ""}`;
}
