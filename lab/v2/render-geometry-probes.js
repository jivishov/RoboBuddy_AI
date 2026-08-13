import {
  add3,
  composeTransform,
  identityTransform,
  rotate3,
  rotationFromQuaternion,
  transformPoint
} from "./math.js";

const DEFAULT_PADDING_MM = 2;
const DEFAULT_SAMPLES_PER_PART = 18;

function boundsCorners(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 6) return [];
  const [minX, minY, minZ, maxX, maxY, maxZ] = bounds.map(Number);
  return [minX, maxX].flatMap((x) => [minY, maxY].flatMap((y) => [minZ, maxZ].map((z) => [x, y, z])));
}

function rotationFromEulerDegrees([x = 0, y = 0, z = 0] = []) {
  const xr = Number(x) * Math.PI / 180;
  const yr = Number(y) * Math.PI / 180;
  const zr = Number(z) * Math.PI / 180;
  const cx = Math.cos(xr); const sx = Math.sin(xr);
  const cy = Math.cos(yr); const sy = Math.sin(yr);
  const cz = Math.cos(zr); const sz = Math.sin(zr);
  // Three.js Euler default order is XYZ.
  return [
    cy * cz, -cy * sz, sy,
    cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy,
    sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy
  ];
}

function base64Bytes(value) {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sampledQuantizedVertices(meshData, meshPayload, limit = DEFAULT_SAMPLES_PER_PART) {
  const bounds = meshPayload?.bounds?.map(Number);
  const vertexCount = Number(meshPayload?.vertexCount);
  if (!meshPayload?.positions || bounds?.length !== 6 || !Number.isInteger(vertexCount) || vertexCount < 1) return [];
  const bytes = base64Bytes(meshPayload.positions);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const quantization = Number(meshData.quantization) || 65535;
  const indexes = new Set([0, vertexCount - 1]);
  const count = Math.min(Math.max(2, limit), vertexCount);
  for (let sample = 0; sample < count; sample += 1) indexes.add(Math.round(sample * (vertexCount - 1) / Math.max(1, count - 1)));
  const extrema = [
    { value: Infinity, index: 0 }, { value: -Infinity, index: 0 },
    { value: Infinity, index: 0 }, { value: -Infinity, index: 0 },
    { value: Infinity, index: 0 }, { value: -Infinity, index: 0 }
  ];
  const decode = (vertex, axis) => {
    const ratio = view.getUint16((vertex * 3 + axis) * 2, true) / quantization;
    return bounds[axis] + (bounds[axis + 3] - bounds[axis]) * ratio;
  };
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = decode(vertex, axis);
      if (value < extrema[axis * 2].value) extrema[axis * 2] = { value, index: vertex };
      if (value > extrema[axis * 2 + 1].value) extrema[axis * 2 + 1] = { value, index: vertex };
    }
  }
  extrema.forEach(({ index }) => indexes.add(index));
  return [...indexes].sort((a, b) => a - b).map((vertex) => [0, 1, 2].map((axis) => decode(vertex, axis)));
}

function transformWithScale(point, position, rotation, scale) {
  const scaled = point.map((value, axis) => value * scale[axis]);
  return add3(position, rotate3(rotation, scaled));
}

function includePoint(boundsByFrame, frameId, point) {
  const bounds = boundsByFrame.get(frameId) || { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
  boundsByFrame.set(frameId, bounds);
}

function boxesFromBounds(boundsByFrame, prefix, provenance, paddingMm = DEFAULT_PADDING_MM) {
  return [...boundsByFrame.entries()].map(([frameId, bounds]) => ({
    id: `${prefix}-${frameId}`,
    type: "box",
    frameId,
    centerMm: bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2),
    halfExtentsMm: bounds.min.map((value, axis) => (bounds.max[axis] - value) / 2 + paddingMm),
    provenance
  }));
}

export function geometryProbesFromOfficialMesh(meshData, options = {}) {
  const boundsByFrame = new Map();
  const samples = [];
  const sampledByMesh = new Map();
  (meshData.parts || []).forEach((part) => {
    if (options.includeGroup && !options.includeGroup(part.group, part)) return;
    const payload = meshData.meshes?.[part.meshKey];
    if (!payload) return;
    const scalar = Number(part.scale);
    const scale = Array.isArray(part.scale3)
      ? part.scale3.map((value) => Number(value) || 1)
      : [0, 1, 2].map(() => Number.isFinite(scalar) && scalar > 0 ? scalar : 1);
    const rotation = rotationFromQuaternion(part.quat || [0, 0, 0, 1]);
    const position = (part.posMm || [0, 0, 0]).map(Number);
    const local = (point) => transformWithScale(point, position, rotation, scale);
    boundsCorners(payload.bounds).map(local).forEach((point) => includePoint(boundsByFrame, part.group || "root", point));
    if (!sampledByMesh.has(part.meshKey)) sampledByMesh.set(part.meshKey, sampledQuantizedVertices(meshData, payload, options.samplesPerPart));
    sampledByMesh.get(part.meshKey).map(local).forEach((point, index) => {
      samples.push({
        id: `${part.key || part.meshKey}-${index}`,
        frameId: part.group || "root",
        localPointMm: point,
        provenance: "M: sampled vertex from the baked renderer mesh"
      });
    });
  });
  return {
    rendererRootOffsetMm: [0, Number(meshData.groundOffsetMm) || 0, 0],
    renderGeometrySamples: samples,
    collisionProxies: boxesFromBounds(
      boundsByFrame,
      options.prefix || "render-mesh",
      "M/C: baked renderer mesh bounds with configured conservative padding",
      options.paddingMm
    )
  };
}

export function geometryProbesFromArduinoRig(config, meshData, options = {}) {
  const boundsByFrame = new Map();
  const samples = [];
  const linkage = config.gripperLinkage;
  const groupBinding = {
    staticBase: { frameId: "root", transform: identityTransform() },
    gripperRoot: {
      frameId: linkage.parent,
      transform: {
        position: [...linkage.rootPosition],
        rotation: rotationFromEulerDegrees(linkage.rootRotation)
      }
    }
  };
  (config.kinematicChain || []).forEach((joint) => {
    groupBinding[joint.id] = { frameId: joint.id, transform: identityTransform() };
  });

  (config.attachments || []).forEach((attachment) => {
    const part = config.parts?.[attachment.part];
    const payload = meshData.meshes?.[part?.meshKey];
    const binding = groupBinding[attachment.parent];
    if (!part || !payload || !binding) return;
    const partTransform = {
      position: [...(part.position || [0, 0, 0])],
      rotation: rotationFromEulerDegrees(part.rotation)
    };
    const transform = composeTransform(binding.transform, partTransform);
    const anchor = part.anchorPoint || [0, 0, 0];
    const local = (point) => transformPoint(transform, point.map((value, axis) => value - anchor[axis]));
    boundsCorners(payload.bounds).map(local).forEach((point) => includePoint(boundsByFrame, binding.frameId, point));
    sampledQuantizedVertices(meshData, payload, options.samplesPerPart).map(local).forEach((point, index) => {
      samples.push({
        id: `${attachment.part}-${index}`,
        frameId: binding.frameId,
        localPointMm: point,
        provenance: "M: sampled vertex from the CAD-derived renderer mesh"
      });
    });
  });

  // The linkage pieces move through a configured four-bar sweep. This box is
  // intentionally larger than the rendered gripper at any supported opening.
  const gripperCenter = transformPoint(groupBinding.gripperRoot.transform, [12, 20, 38]);
  includePoint(boundsByFrame, linkage.parent, gripperCenter.map((value) => value - 92));
  includePoint(boundsByFrame, linkage.parent, gripperCenter.map((value) => value + 92));
  return {
    rendererRootOffsetMm: [0, 0, 0],
    renderGeometrySamples: samples,
    collisionProxies: boxesFromBounds(
      boundsByFrame,
      "render-cad",
      "M/C: CAD-derived renderer bounds and configured linkage sweep padding",
      options.paddingMm
    )
  };
}
