export function createTaskObjects(THREE, definitions = []) {
  const group = new THREE.Group();
  group.name = "unitree-g1-task-objects";
  const objects = new Map();
  definitions.forEach((definition) => {
    const radius = Math.max(4, Number(definition.radiusMm) || 20);
    const length = Math.max(radius * 2, Number(definition.lengthMm) || 120);
    const geometry = definition.shape === "capsule" && typeof THREE.CapsuleGeometry === "function"
      ? new THREE.CapsuleGeometry(radius, Math.max(1, length - radius * 2), 6, 18)
      : new THREE.CylinderGeometry(radius, radius, length, 24);
    const material = new THREE.MeshStandardMaterial({
      color: Number(definition.color) || 0x58d68d,
      roughness: 0.48,
      metalness: 0.08
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = definition.id;
    mesh.userData.taskObjectId = definition.id;
    mesh.userData.homePositionMm = [...(definition.positionMm || [0, 0, 0])];
    mesh.position.fromArray(mesh.userData.homePositionMm);
    mesh.rotation.z = Math.PI / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    objects.set(definition.id, mesh);
  });
  return { group, objects };
}

export function resetTaskObjects(taskObjects) {
  if (!taskObjects || !taskObjects.objects) return;
  taskObjects.objects.forEach((mesh) => {
    taskObjects.group.attach(mesh);
    mesh.position.fromArray(mesh.userData.homePositionMm || [0, 0, 0]);
    mesh.rotation.set(0, 0, Math.PI / 2);
    mesh.userData.heldBy = "";
  });
}
