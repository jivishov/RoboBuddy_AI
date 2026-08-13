import { canonicalRendererData, getRobotModel, loadRobotModel } from "./robot-model-catalog.js";

export function bindStaticRendererModel(robotId, renderer) {
  const model = getRobotModel(robotId);
  if (!model) throw new Error(`No canonical renderer model is registered for ${robotId}.`);
  renderer.canonicalRobotModel = model;
  renderer.canonicalModelRevision = model.source.revision;
  return model;
}

export async function bindMeshRendererModel(robotId, renderer, meshData) {
  const model = await loadRobotModel(robotId);
  const canonicalData = await canonicalRendererData(robotId, meshData);
  renderer.canonicalRobotModel = model;
  renderer.canonicalModelRevision = model.source.revision;
  return canonicalData;
}
