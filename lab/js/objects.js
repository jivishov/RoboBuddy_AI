import * as THREE from "three";

const COLORS = Object.freeze({
  glass: 0xc7edf0,
  glassEdge: 0x2c6f73,
  ceramic: 0xf2eee4,
  whitePlastic: 0xe8e5dc,
  darkPlastic: 0x242d32,
  metal: 0x9aa6ac,
  brushedMetal: 0xc3c8c8,
  paper: 0xf2ead4,
  carrier: 0x2c7771,
  carrierDark: 0x184e4b,
  accent: 0x1d8078,
  warning: 0xb26a2c,
  danger: 0x9e3e45,
  liquid: 0x4f9bb3,
  neutral: 0x6d7b82,
  black: 0x151a1d
});

export const APPARATUS_REFERENCE_ASSETS = Object.freeze({
  balance: "analytical-balance.png",
  watch_glass: "watch-glass.png",
  weigh_boat: "weigh-boat.png",
  beaker: "beaker-250ml.png",
  cylinder: "graduated-cylinder-100ml.png",
  flask: "erlenmeyer-flask-250ml.png",
  volumetric_flask: "volumetric-flask.png",
  stopper: "volumetric-flask-stoppered.png",
  filter_flask: "side-arm-filter-flask.png",
  cuvette: "cuvette.png",
  rack: "sample-rack.png",
  instrument: "spectrophotometer.png",
  filter_paper: "filter-paper.png",
  funnel: "funnel.png",
  buchner_funnel: "buchner-funnel.png",
  burette: "ring-stand-burette.png",
  stand: "ring-stand.png",
  bottle: "reagent-bottle.png",
  wash_bottle: "wash-bottle.png",
  pipette: "volumetric-pipette-10ml.png",
  pipette_pump: "pipette-pump.png",
  oven: "drying-oven.png",
  chromatography_paper: "chromatography-paper.png",
  chromatography_chamber: "chromatography-chamber-with-paper.png",
  separatory_funnel: "separatory-funnel.png",
  vacuum_source: "vacuum-source.png",
  secured_carrier: "reagent-tray.png"
});

function standardMaterial(color, options = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.52,
    metalness: options.metalness ?? 0.03,
    transparent: Boolean(options.transparent),
    opacity: options.opacity ?? 1,
    side: options.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 0,
    envMapIntensity: options.envMapIntensity ?? 1
  });
}

function glassMaterial(opacity = 0.4, tint = COLORS.glass) {
  return new THREE.MeshPhysicalMaterial({
    color: tint,
    roughness: 0.075,
    metalness: 0,
    transmission: 0.7,
    thickness: 0.72,
    ior: 1.47,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    clearcoat: 0.9,
    clearcoatRoughness: 0.045,
    depthWrite: false,
    envMapIntensity: 1.28
  });
}

function markComponent(object, name, role = name) {
  object.name = name;
  object.userData.componentRole = role;
  return object;
}

function makeMesh(geometry, objectMaterial, position = [0, 0, 0], rotation = [0, 0, 0]) {
  const object = new THREE.Mesh(geometry, objectMaterial);
  object.position.set(...position);
  object.rotation.set(...rotation);
  object.castShadow = true;
  object.receiveShadow = true;
  return object;
}

function addMesh(group, geometry, objectMaterial, position, rotation) {
  const object = makeMesh(geometry, objectMaterial, position, rotation);
  group.add(object);
  return object;
}

function addBox(group, size, objectMaterial, position, rotation) {
  return addMesh(group, new THREE.BoxGeometry(...size), objectMaterial, position, rotation);
}

function addCylinder(group, radii, height, objectMaterial, position, rotation, segments = 28, openEnded = false) {
  return addMesh(group, new THREE.CylinderGeometry(radii[0], radii[1], height, segments, 1, openEnded), objectMaterial, position, rotation);
}

function addTorus(group, radius, tube, objectMaterial, position, rotation = [Math.PI / 2, 0, 0], segments = 32) {
  return addMesh(group, new THREE.TorusGeometry(radius, tube, 10, segments), objectMaterial, position, rotation);
}

function roundedRectShape(width, height, radius) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const r = Math.max(0.5, Math.min(radius, halfWidth - 0.5, halfHeight - 0.5));
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + r, -halfHeight);
  shape.lineTo(halfWidth - r, -halfHeight);
  shape.quadraticCurveTo(halfWidth, -halfHeight, halfWidth, -halfHeight + r);
  shape.lineTo(halfWidth, halfHeight - r);
  shape.quadraticCurveTo(halfWidth, halfHeight, halfWidth - r, halfHeight);
  shape.lineTo(-halfWidth + r, halfHeight);
  shape.quadraticCurveTo(-halfWidth, halfHeight, -halfWidth, halfHeight - r);
  shape.lineTo(-halfWidth, -halfHeight + r);
  shape.quadraticCurveTo(-halfWidth, -halfHeight, -halfWidth + r, -halfHeight);
  return shape;
}

function roundedBoxGeometry(size, radius = 5, bevel = 1.2) {
  const geometry = new THREE.ExtrudeGeometry(roundedRectShape(size[0], size[1], radius), {
    depth: size[2],
    steps: 1,
    bevelEnabled: bevel > 0,
    bevelSegments: bevel > 0 ? 2 : 0,
    bevelSize: Math.min(bevel, radius * 0.35),
    bevelThickness: Math.min(bevel, size[2] * 0.18)
  });
  geometry.translate(0, 0, -size[2] / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function addRoundedBox(group, size, radius, objectMaterial, position, rotation) {
  return addMesh(group, roundedBoxGeometry(size, radius), objectMaterial, position, rotation);
}

function perforatedPlateGeometry(width, depth, thickness, holes) {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, -depth / 2);
  shape.lineTo(width / 2, -depth / 2);
  shape.lineTo(width / 2, depth / 2);
  shape.lineTo(-width / 2, depth / 2);
  shape.closePath();
  holes.forEach(([x, z, radius]) => {
    const opening = new THREE.Path();
    opening.absellipse(x, z, radius, radius, 0, Math.PI * 2, true);
    shape.holes.push(opening);
  });
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, steps: 1, bevelEnabled: false, curveSegments: 16 });
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, thickness / 2, 0);
  geometry.computeVertexNormals();
  return geometry;
}

function addTube(group, points, radius, objectMaterial, name, tubularSegments = 24) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)));
  return markComponent(addMesh(group, new THREE.TubeGeometry(curve, tubularSegments, radius, 10, false), objectMaterial), name);
}

function setObjectMetadata(group, metadata) {
  group.userData = {
    ...group.userData,
    heightMm: metadata.heightMm,
    footprintMm: metadata.footprintMm,
    sockets: metadata.sockets || {},
    attachmentAnchors: metadata.attachmentAnchors || {},
    referenceAsset: metadata.referenceAsset,
    labObjectId: metadata.id,
    visualVariant: metadata.visualVariant || "standard"
  };
  return group;
}

function glassLathe(points, radialSegments = 36) {
  return new THREE.LatheGeometry(points.map(([radius, y]) => new THREE.Vector2(radius, y)), radialSegments);
}

function addGlassRim(group, radius, y, tube = 1.8) {
  addTorus(group, radius, tube, standardMaterial(COLORS.glassEdge, { roughness: 0.18, transparent: true, opacity: 0.72 }), [0, y, 0]);
}

function addGraduations(group, radius, startY, count, spacing, longEvery = 5) {
  const ink = standardMaterial(0x56666b, { roughness: 0.72 });
  for (let index = 0; index < count; index += 1) {
    const width = index % longEvery === 0 ? 14 : 8;
    markComponent(addBox(group, [width, 0.8, 0.8], ink, [radius - width / 2 - 1, startY + index * spacing, radius + 0.45]), `graduation-${index}`, "graduation");
  }
}

function createBalance() {
  const group = new THREE.Group();
  const ivory = standardMaterial(COLORS.whitePlastic, { roughness: 0.42 });
  const dark = standardMaterial(COLORS.darkPlastic, { roughness: 0.34 });
  const steel = standardMaterial(COLORS.brushedMetal, { roughness: 0.24, metalness: 0.72 });
  markComponent(addRoundedBox(group, [142, 12, 118], 8, standardMaterial(COLORS.black, { roughness: 0.7 }), [0, 6, 0]), "balance-plinth", "base");
  markComponent(addRoundedBox(group, [138, 46, 114], 10, ivory, [0, 35, 0]), "balance-housing", "housing");
  markComponent(addRoundedBox(group, [120, 30, 5], 5, dark, [0, 30, 59], [-0.16, 0, 0]), "balance-control-panel", "control-panel");
  markComponent(addRoundedBox(group, [68, 17, 2], 3, standardMaterial(0x23312e, { emissive: 0x395c54, emissiveIntensity: 0.16 }), [-20, 33, 62], [-0.16, 0, 0]), "display", "display");
  [-20, 5, 30].forEach((x, index) => markComponent(addCylinder(group, [6.2, 6.2], 2.8, standardMaterial(index === 1 ? 0xe1e2dc : 0x7d8990, { roughness: 0.35 }), [x, 22, 62.5], [Math.PI / 2, 0, 0], 24), `balance-button-${index + 1}`, "control"));
  markComponent(addRoundedBox(group, [110, 8, 92], 5, steel, [0, 63, -8]), "balance-pan-support", "pan-support");
  markComponent(addRoundedBox(group, [103, 3, 85], 4, standardMaterial(0xe1e3df, { roughness: 0.18, metalness: 0.58 }), [0, 68.5, -8]), "balance-pan", "placement-surface");
  [-58, 58].forEach((x) => [-44, 44].forEach((z) => markComponent(addCylinder(group, [5, 5], 4, standardMaterial(0x161a1c, { roughness: 0.8 }), [x, -2, z]), "balance-foot", "foot")));
  return setObjectMetadata(group, { heightMm: 70, footprintMm: [148, 122], sockets: { place: [0, 71, -8], insert: [0, 71, -8] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.balance });
}

function createWatchGlass() {
  const group = new THREE.Group();
  const glass = glassMaterial(0.36);
  const profile = [[0, 1.2], [25, 1.8], [35, 3.2], [40, 5.4], [39, 7.1], [34, 5.3], [24, 3.3], [0, 2.2]];
  markComponent(addMesh(group, glassLathe(profile, 48), glass), "watch-glass-dish", "vessel");
  markComponent(addTorus(group, 39.4, 1.6, standardMaterial(COLORS.glassEdge, { transparent: true, opacity: 0.58, roughness: 0.12 }), [0, 6.2, 0]), "watch-glass-rim", "rim");
  return setObjectMetadata(group, { heightMm: 8, footprintMm: [84, 84], sockets: { grip: [0, 5, 0], attach: [0, 0, 0] }, attachmentAnchors: { grip: [0, 5, 0], attach: [0, 0, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.watch_glass });
}

function createWeighBoat() {
  const group = new THREE.Group();
  const plastic = standardMaterial(0xf1efe7, { roughness: 0.32 });
  markComponent(addRoundedBox(group, [70, 3, 54], 8, plastic, [0, 2, 0]), "weigh-boat-floor", "vessel-floor");
  markComponent(addRoundedBox(group, [72, 10, 3], 1.5, plastic, [0, 6, -27], [0.08, 0, 0]), "weigh-boat-back", "wall");
  markComponent(addRoundedBox(group, [72, 10, 3], 1.5, plastic, [0, 6, 27], [-0.08, 0, 0]), "weigh-boat-front", "wall");
  markComponent(addRoundedBox(group, [3, 10, 50], 1.5, plastic, [-35, 6, 0], [0, 0, -0.08]), "weigh-boat-left", "wall");
  markComponent(addRoundedBox(group, [3, 10, 50], 1.5, plastic, [35, 6, 0], [0, 0, 0.08]), "weigh-boat-right", "wall");
  return setObjectMetadata(group, { heightMm: 12, footprintMm: [74, 58], sockets: { grip: [0, 7, 0], attach: [0, 0, 0] }, attachmentAnchors: { grip: [0, 7, 0], attach: [0, 0, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.weigh_boat });
}

function createBeaker() {
  const group = new THREE.Group();
  const glass = glassMaterial(0.42);
  addCylinder(group, [34, 32], 76, glass, [0, 38, 0], [0, 0, 0], 34, true);
  addCylinder(group, [31, 31], 3, glass, [0, 2, 0]);
  addGlassRim(group, 34, 77, 1.7);
  addGraduations(group, 31, 18, 6, 8, 2);
  addMesh(group, new THREE.ConeGeometry(7, 16, 3), glass, [32, 74, 0], [0, 0, -Math.PI / 2]);
  return setObjectMetadata(group, { heightMm: 80, footprintMm: [74, 74], sockets: { receive: [0, 62, 0], place: [0, 82, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.beaker });
}

function createGraduatedCylinder() {
  const group = new THREE.Group();
  const glass = glassMaterial(0.37);
  markComponent(addRoundedBox(group, [58, 5, 50], 7, glass, [0, 2.5, 0]), "graduated-cylinder-foot", "foot");
  markComponent(addCylinder(group, [15, 15], 116, glass, [0, 62, 0], [0, 0, 0], 36, true), "graduated-cylinder-wall", "vessel");
  markComponent(addCylinder(group, [14, 14], 3, glass, [0, 5, 0]), "graduated-cylinder-base", "vessel-base");
  addGlassRim(group, 15, 121, 1.4);
  addGraduations(group, 13, 20, 14, 6.3, 5);
  return setObjectMetadata(group, { heightMm: 124, footprintMm: [62, 54], sockets: { receive: [0, 112, 0], grip: [0, 70, 0], attach: [0, 0, 0] }, attachmentAnchors: { grip: [0, 70, 0], attach: [0, 0, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.cylinder });
}

function createErlenmeyerFlask() {
  const group = new THREE.Group();
  const glass = glassMaterial(0.43);
  addMesh(group, glassLathe([[36, 0], [39, 5], [37, 18], [31, 55], [15, 83], [14, 111]]), glass);
  addGlassRim(group, 14, 111, 1.8);
  addTorus(group, 35, 1.5, standardMaterial(COLORS.glassEdge, { transparent: true, opacity: 0.48 }), [0, 3, 0]);
  return setObjectMetadata(group, { heightMm: 114, footprintMm: [80, 80], sockets: { receive: [0, 98, 0], insert: [0, 112, 0], place: [0, 116, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.flask });
}

function createVolumetricFlask() {
  const group = new THREE.Group();
  const glass = glassMaterial(0.43);
  addMesh(group, glassLathe([[29, 0], [34, 4], [35, 20], [31, 42], [17, 63], [9, 76], [9, 151]]), glass);
  addGlassRim(group, 9, 151, 1.8);
  addTorus(group, 9.3, 0.8, standardMaterial(0x7b5c48, { roughness: 0.6 }), [0, 116, 0]);
  return setObjectMetadata(group, { heightMm: 154, footprintMm: [72, 72], sockets: { receive: [0, 145, 0], insert: [0, 153, 0], place: [0, 156, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.volumetric_flask });
}

function createFilterFlask() {
  const group = createErlenmeyerFlask();
  const glass = glassMaterial(0.5);
  markComponent(addCylinder(group, [7, 9], 54, glass, [31, 75, 0], [0, 0, -Math.PI / 2.8], 20, true), "filter-flask-sidearm", "vacuum-port");
  for (let index = 0; index < 3; index += 1) addTorus(group, 7.8, 1, standardMaterial(COLORS.glassEdge, { transparent: true, opacity: 0.58 }), [47 + index * 7, 88 + index * 4, 0], [0, Math.PI / 2, 0]);
  group.userData.referenceAsset = APPARATUS_REFERENCE_ASSETS.filter_flask;
  group.userData.sockets.vacuum = [57, 94, 0];
  group.userData.sockets.insert = [0, 112, 0];
  group.userData.sockets.grip = [0, 68, 0];
  group.userData.sockets.attach = [0, 0, 0];
  group.userData.attachmentAnchors = { grip: [0, 68, 0], attach: [0, 0, 0] };
  return group;
}

function createStopper() {
  const group = new THREE.Group();
  const frostedGlass = glassMaterial(0.56, 0xe8efed);
  markComponent(addCylinder(group, [10, 7], 18, frostedGlass, [0, 9, 0], [0, 0, 0], 28), "stopper-plug", "insertable-plug");
  markComponent(addCylinder(group, [13, 11], 5, frostedGlass, [0, 20.5, 0], [0, 0, 0], 28), "stopper-flange", "grasp-surface");
  markComponent(addMesh(group, new THREE.SphereGeometry(8, 22, 14), frostedGlass, [0, 31, 0]), "stopper-knob", "grasp-knob");
  return setObjectMetadata(group, { heightMm: 39, footprintMm: [27, 27], sockets: { attach: [0, 0, 0], grip: [0, 29, 0] }, attachmentAnchors: { attach: [0, 0, 0], grip: [0, 29, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.stopper });
}

function createCuvette() {
  const group = new THREE.Group();
  const glass = glassMaterial(0.34);
  const wall = standardMaterial(COLORS.glassEdge, { transparent: true, opacity: 0.38, roughness: 0.1 });
  markComponent(addBox(group, [18, 2, 18], glass, [0, 1, 0]), "cuvette-base", "vessel-base");
  [[-8.4, 27, 0, 1.2, 52, 18], [8.4, 27, 0, 1.2, 52, 18], [0, 27, -8.4, 16, 52, 1.2], [0, 27, 8.4, 16, 52, 1.2]].forEach(([x, y, z, w, h, d], index) => markComponent(addBox(group, [w, h, d], wall, [x, y, z]), `cuvette-wall-${index + 1}`, "optical-wall"));
  const liquid = markComponent(addBox(group, [14.8, 34, 14.8], standardMaterial(COLORS.liquid, { transparent: true, opacity: 0.3, roughness: 0.12 }), [0, 18, 0]), "liquid", "configured-liquid");
  liquid.userData.simulatedContents = true;
  markComponent(addBox(group, [15, 4, 1.5], standardMaterial(COLORS.glassEdge, { transparent: true, opacity: 0.64 }), [0, 49, 9]), "cuvette-orientation-mark", "orientation-mark");
  addTorus(group, 10.9, 0.9, wall, [0, 53, 0], [Math.PI / 2, 0, 0], 4);
  return setObjectMetadata(group, { heightMm: 55, footprintMm: [20, 20], sockets: { attach: [0, 0, 0], grip: [0, 44, 0] }, attachmentAnchors: { attach: [0, 0, 0], grip: [0, 44, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.cuvette });
}

function createFilterPaper(visualVariant = "standard") {
  const group = new THREE.Group();
  const paper = standardMaterial(COLORS.paper, { roughness: 0.92, doubleSided: true });
  if (["folded", "gravity-cone", "gravity_cone", "cone"].includes(visualVariant)) {
    const cone = markComponent(addMesh(group, new THREE.ConeGeometry(29, 34, 42, 1, true), paper, [0, 17, 0], [0, 0, Math.PI]), "filter-paper-cone", "filter-medium");
    cone.scale.set(0.98, 1, 0.98);
    markComponent(addTorus(group, 29, 0.7, standardMaterial(0xd1c6ad, { roughness: 0.9 }), [0, 34, 0]), "filter-paper-edge", "edge");
    return setObjectMetadata(group, { heightMm: 35, footprintMm: [60, 60], sockets: { attach: [0, 0, 0], grip: [0, 28, 0] }, attachmentAnchors: { attach: [0, 0, 0], grip: [0, 28, 0] }, visualVariant, referenceAsset: APPARATUS_REFERENCE_ASSETS.filter_paper });
  }
  markComponent(addCylinder(group, [30, 30], 1.1, paper, [0, 0.6, 0], [0, 0, 0], 42), "filter-paper-disc", "filter-medium");
  markComponent(addMesh(group, new THREE.CircleGeometry(29, 42), standardMaterial(0xe6ddc6, { roughness: 0.94, doubleSided: true }), [0, 1.2, 0], [-Math.PI / 2, 0, 0]), "filter-paper-face", "filter-medium");
  return setObjectMetadata(group, { heightMm: 2, footprintMm: [62, 62], sockets: { attach: [0, 0, 0], grip: [0, 1, 0] }, attachmentAnchors: { attach: [0, 0, 0], grip: [0, 1, 0] }, visualVariant, referenceAsset: APPARATUS_REFERENCE_ASSETS.filter_paper });
}

function createChromatographyPaper() {
  const group = new THREE.Group();
  const paper = standardMaterial(COLORS.paper, { roughness: 0.92, doubleSided: true });
  addBox(group, [42, 82, 1.6], paper, [0, 43, 0]);
  addBox(group, [34, 1.2, 2], standardMaterial(0x766b5d, { roughness: 0.82 }), [0, 18, 1.2]);
  [-10, 0, 10].forEach((x) => addCylinder(group, [2.1, 2.1], 1, standardMaterial(0x375e9c), [x, 19, 2.4], [Math.PI / 2, 0, 0], 16));
  addBox(group, [48, 4, 20], standardMaterial(0x6c7678, { roughness: 0.64 }), [0, 2, 0]);
  return setObjectMetadata(group, { heightMm: 86, footprintMm: [50, 22], sockets: {}, referenceAsset: APPARATUS_REFERENCE_ASSETS.chromatography_paper });
}

function createGravityFunnel() {
  const group = new THREE.Group();
  const glass = glassMaterial(0.34);
  markComponent(addMesh(group, new THREE.ConeGeometry(38, 66, 40, 1, true), glass, [0, 76, 0], [0, 0, Math.PI]), "gravity-funnel-cone", "vessel");
  markComponent(addCylinder(group, [5, 5], 58, glass, [0, 28, 0], [0, 0, 0], 20, true), "gravity-funnel-stem", "delivery-stem");
  addGlassRim(group, 38, 109, 2);
  return setObjectMetadata(group, { heightMm: 112, footprintMm: [82, 82], sockets: { insert: [0, 79, 0], receive: [0, 103, 0], attach: [0, 54, 0], grip: [0, 84, 0] }, attachmentAnchors: { attach: [0, 54, 0], grip: [0, 84, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.funnel });
}

function createBuchnerFunnel() {
  const group = new THREE.Group();
  const ceramic = standardMaterial(COLORS.ceramic, { roughness: 0.34 });
  markComponent(addCylinder(group, [36, 34], 48, ceramic, [0, 73, 0], [0, 0, 0], 36, true), "buchner-cup", "filter-cup");
  markComponent(addCylinder(group, [28, 28], 3, ceramic, [0, 51, 0]), "buchner-perforated-plate", "filter-support");
  markComponent(addCylinder(group, [7, 9], 50, ceramic, [0, 25, 0]), "buchner-stem", "insertable-stem");
  const dark = standardMaterial(0x98968d, { roughness: 0.85 });
  for (let x = -18; x <= 18; x += 9) for (let z = -18; z <= 18; z += 9) {
    if (x * x + z * z <= 360) addCylinder(group, [1.2, 1.2], 0.8, dark, [x, 53, z], [0, 0, 0], 10);
  }
  addTorus(group, 35, 1.6, standardMaterial(0xd8d3c8, { roughness: 0.25 }), [0, 97, 0]);
  return setObjectMetadata(group, { heightMm: 98, footprintMm: [76, 76], sockets: { insert: [0, 52.8, 0], receive: [0, 88, 0], attach: [0, 0, 0], grip: [0, 76, 0] }, attachmentAnchors: { attach: [0, 0, 0], grip: [0, 76, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.buchner_funnel });
}

function createSeparatoryFunnel() {
  const group = new THREE.Group();
  const glass = glassMaterial(0.45);
  markComponent(addMesh(group, glassLathe([[4, 22], [5, 35], [18, 52], [34, 87], [30, 116], [14, 132], [11, 150]]), glass), "separatory-funnel-body", "vessel");
  const liquid = markComponent(addMesh(group, glassLathe([[4, 42], [18, 53], [32, 85], [28, 105], [13, 120]], 30), standardMaterial(0xd6a456, { transparent: true, opacity: 0.2, roughness: 0.18 })), "liquid", "configured-liquid");
  liquid.userData.simulatedContents = true;
  addCylinder(group, [4, 4], 28, glass, [0, 12, 0], [0, 0, 0], 18, true);
  addCylinder(group, [12, 9], 20, glass, [0, 160, 0], [0, 0, 0], 24);
  addMesh(group, new THREE.SphereGeometry(13, 24, 14), glass, [0, 178, 0]);
  const stopcock = new THREE.Group();
  stopcock.name = "stopcock";
  stopcock.userData.componentRole = "control";
  addCylinder(stopcock, [7, 7], 42, glass, [0, 0, 0], [0, 0, Math.PI / 2], 18, true);
  addCylinder(stopcock, [8, 8], 15, standardMaterial(0x2c5aa0, { roughness: 0.52 }), [-25, 0, 0], [0, 0, Math.PI / 2]);
  addBox(stopcock, [5, 27, 5], standardMaterial(0xd5d9d8, { roughness: 0.35 }), [21, 0, 0]);
  stopcock.position.set(0, 38, 0);
  group.add(stopcock);
  return setObjectMetadata(group, { heightMm: 192, footprintMm: [78, 78], sockets: { receive: [0, 164, 0], control: [0, 38, 0], grip: [0, 98, 0], attach: [0, 0, 0] }, attachmentAnchors: { grip: [0, 98, 0], attach: [0, 0, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.separatory_funnel });
}

function createBuretteAssembly() {
  const group = new THREE.Group();
  const metal = standardMaterial(COLORS.metal, { roughness: 0.22, metalness: 0.78 });
  const glass = glassMaterial(0.36);
  const base = markComponent(addRoundedBox(group, [126, 14, 92], 6, standardMaterial(0x363c3f, { roughness: 0.55, metalness: 0.2 }), [-22, 7, 0]), "burette-stand-base", "base");
  base.userData.weightedBase = true;
  [-74, 30].forEach((x) => [-34, 34].forEach((z) => markComponent(addCylinder(group, [5, 5], 4, standardMaterial(0x15191b, { roughness: 0.8 }), [x, -2, z]), "burette-foot", "foot")));
  markComponent(addCylinder(group, [5.5, 5.5], 380, metal, [-50, 205, 0]), "burette-support-rod", "support-rod");
  const clamp = new THREE.Group();
  clamp.name = "burette-clamp";
  clamp.userData.componentRole = "clamp";
  markComponent(addBox(clamp, [48, 11, 15], metal, [-25, 0, 0]), "burette-clamp-arm", "clamp-arm");
  markComponent(addCylinder(clamp, [7, 7], 13, standardMaterial(0x30383b, { roughness: 0.48 }), [-48, 0, 0], [Math.PI / 2, 0, 0], 20), "burette-bosshead", "bosshead");
  [[12, -7], [12, 7]].forEach(([x, z]) => markComponent(addBox(clamp, [20, 5, 5], standardMaterial(0x252c2f, { roughness: 0.4, metalness: 0.45 }), [x, 0, z], [0, z < 0 ? -0.2 : 0.2, 0]), "burette-clamp-jaw", "clamp-jaw"));
  clamp.position.set(-2, 330, 0);
  group.add(clamp);
  markComponent(addCylinder(group, [5.2, 5.2], 126, glass, [20, 329, 0], [0, 0, 0], 24, true), "burette-tube", "graduated-vessel");
  addGlassRim(group, 5.4, 392, 0.8);
  addGraduations(group, 4.5, 275, 20, 5.5, 5);
  const liquid = markComponent(addCylinder(group, [3.5, 3.5], 92, standardMaterial(COLORS.liquid, { transparent: true, opacity: 0.28, roughness: 0.12 }), [20, 330, 0]), "liquid", "configured-liquid");
  liquid.userData.simulatedContents = true;
  const stopcock = new THREE.Group();
  stopcock.name = "stopcock";
  stopcock.userData.componentRole = "control";
  markComponent(addCylinder(stopcock, [6.5, 6.5], 42, glass, [0, 0, 0], [0, 0, Math.PI / 2], 20, true), "stopcock-barrel", "stopcock-barrel");
  markComponent(addCylinder(stopcock, [8, 8], 13, standardMaterial(0x285f9b, { roughness: 0.46 }), [-26, 0, 0], [0, 0, Math.PI / 2], 20), "stopcock-knob", "stopcock-handle");
  markComponent(addBox(stopcock, [5, 29, 5], standardMaterial(0xd9dddd, { roughness: 0.3 }), [22, 0, 0]), "stopcock-handle", "stopcock-handle");
  stopcock.position.set(20, 248, 0);
  group.add(stopcock);
  markComponent(addCylinder(group, [3.7, 4.6], 34, glass, [20, 222, 0], [0, 0, 0], 18, true), "burette-delivery-neck", "delivery-neck");
  markComponent(addMesh(group, new THREE.ConeGeometry(3.8, 48, 18, 1, true), glass, [20, 177, 0], [0, 0, Math.PI]), "burette-delivery-tip", "delivery-tip");
  return setObjectMetadata(group, {
    heightMm: 398,
    footprintMm: [132, 98],
    sockets: { insert: [20, 394, 0], fill: [20, 394, 0], control: [20, 248, 0], delivery: [20, 153, 0], receive: [20, 16, 0], receiver: [20, 16, 0], place: [20, 16, 0], grip: [-50, 245, 0] },
    attachmentAnchors: { grip: [-50, 245, 0] },
    referenceAsset: APPARATUS_REFERENCE_ASSETS.burette
  });
}

function createRingStand() {
  const group = new THREE.Group();
  const metal = standardMaterial(COLORS.metal, { roughness: 0.25, metalness: 0.74 });
  markComponent(addRoundedBox(group, [116, 12, 86], 5, standardMaterial(0x383e41, { roughness: 0.55, metalness: 0.2 }), [0, 6, 0]), "ring-stand-base", "base");
  markComponent(addCylinder(group, [6, 6], 230, metal, [-32, 127, 0]), "ring-stand-rod", "support-rod");
  markComponent(addBox(group, [72, 10, 15], metal, [0, 150, 0]), "ring-stand-clamp-arm", "clamp-arm");
  markComponent(addTorus(group, 30, 3, metal, [32, 150, 0]), "ring-stand-ring", "support-ring");
  markComponent(addCylinder(group, [7, 7], 12, standardMaterial(0x30383b, { roughness: 0.48 }), [-31, 150, 0], [Math.PI / 2, 0, 0], 20), "ring-stand-bosshead", "bosshead");
  return setObjectMetadata(group, { heightMm: 242, footprintMm: [120, 90], sockets: { insert: [32, 150, 0], place: [32, 150, 0], grip: [-32, 115, 0], attach: [0, 0, 0] }, attachmentAnchors: { grip: [-32, 115, 0], attach: [0, 0, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.stand });
}

function createPipette() {
  const group = new THREE.Group();
  const glass = glassMaterial(0.38);
  markComponent(addCylinder(group, [3.4, 3.4], 69, glass, [-55, 13, 0], [0, 0, Math.PI / 2], 20, true), "pipette-upper-stem", "upper-stem");
  const bulb = markComponent(addMesh(group, glassLathe([[3.5, -19], [6, -15], [9, -8], [9.5, 0], [9, 8], [6, 15], [3.5, 19]], 30), glass, [0, 13, 0], [0, 0, Math.PI / 2]), "pipette-bulb", "volumetric-bulb");
  bulb.userData.nominalCapacity = "10 mL";
  markComponent(addCylinder(group, [3.2, 1.2], 84, glass, [61.5, 13, 0], [0, 0, Math.PI / 2], 20, true), "pipette-delivery-stem", "delivery-stem");
  markComponent(addTorus(group, 3.8, 0.8, standardMaterial(COLORS.glassEdge, { transparent: true, opacity: 0.55, roughness: 0.1 }), [-90, 13, 0], [0, Math.PI / 2, 0]), "pipette-mouth-rim", "rim");
  markComponent(addTorus(group, 3.75, 0.7, standardMaterial(0x8b6c42, { roughness: 0.6 }), [-45, 13, 0], [0, Math.PI / 2, 0]), "pipette-calibration-line", "calibration-mark");
  return setObjectMetadata(group, { heightMm: 24, footprintMm: [182, 22], sockets: { insert: [-92, 13, 0], receive: [-92, 13, 0], attach: [91, 13, 0], grip: [0, 13, 0] }, attachmentAnchors: { attach: [91, 13, 0], grip: [0, 13, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.pipette });
}

function createPipettePump() {
  const group = new THREE.Group();
  const red = standardMaterial(0xc33f32, { roughness: 0.3 });
  markComponent(addRoundedBox(group, [34, 82, 24], 10, red, [0, 47, 0]), "pipette-pump-housing", "housing");
  markComponent(addRoundedBox(group, [22, 58, 3], 7, standardMaterial(0xd94b3c, { roughness: 0.24 }), [0, 50, 13]), "pipette-pump-grip-panel", "grasp-surface");
  const upperWheel = markComponent(addCylinder(group, [15, 15], 10, standardMaterial(0xc5c7c6, { roughness: 0.52 }), [0, 93, 0], [Math.PI / 2, 0, 0], 32), "pipette-pump-thumbwheel", "control");
  upperWheel.userData.controlMode = "aspirate";
  const release = markComponent(addCylinder(group, [13, 13], 10, standardMaterial(0x202427, { roughness: 0.64 }), [0, 5, 0], [Math.PI / 2, 0, 0], 28), "pipette-pump-release", "control");
  release.userData.controlMode = "release";
  for (let index = 0; index < 18; index += 1) {
    const angle = index / 18 * Math.PI * 2;
    addBox(group, [1.5, 2.8, 10.8], standardMaterial(0xaeb1b0, { roughness: 0.64 }), [Math.cos(angle) * 14.7, 93 + Math.sin(angle) * 14.7, 0], [0, 0, angle]);
  }
  markComponent(addBox(group, [5, 72, 5], standardMaterial(0xe7e8e5, { roughness: 0.28 }), [-16, 43, 0]), "pipette-pump-channel", "pipette-channel");
  markComponent(addCylinder(group, [4.2, 5.5], 9, standardMaterial(0x252a2c, { roughness: 0.62 }), [0, 0, 0]), "pipette-pump-socket", "attachment-socket");
  return setObjectMetadata(group, { heightMm: 108, footprintMm: [42, 30], sockets: { insert: [0, 0, 0], attach: [0, 0, 0], grip: [0, 50, 0] }, attachmentAnchors: { attach: [0, 0, 0], grip: [0, 50, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.pipette_pump });
}

function createBottle(id, visualVariant = "standard") {
  const group = new THREE.Group();
  const isWash = id.includes("wash") || ["wash-bottle", "wash_bottle"].includes(visualVariant);
  const body = standardMaterial(isWash ? 0xe4e7e2 : 0x8e4b1f, { roughness: isWash ? 0.38 : 0.22, transparent: !isWash, opacity: isWash ? 1 : 0.78, envMapIntensity: 1.2 });
  if (isWash) {
    markComponent(addCylinder(group, [27, 27], 76, body, [0, 38, 0], [0, 0, 0], 32), "wash-bottle-body", "vessel");
  } else {
    markComponent(addRoundedBox(group, [58, 76, 46], 9, body, [0, 38, 0]), "reagent-bottle-body", "amber-vessel");
    markComponent(addRoundedBox(group, [51, 10, 40], 7, body, [0, 80, 0]), "reagent-bottle-shoulder", "shoulder");
  }
  markComponent(addCylinder(group, [15, 17], 13, body, [0, 87, 0], [0, 0, 0], 28), "bottle-neck", "neck");
  const cap = markComponent(addCylinder(group, [18, 18], 16, standardMaterial(isWash ? 0xe6e6df : 0x20282c, { roughness: 0.58 }), [0, 101, 0], [0, 0, 0], 28), "bottle-cap", "closure");
  cap.userData.closed = true;
  markComponent(addRoundedBox(group, [42, 27, 1.8], 2, standardMaterial(isWash ? 0xd5dedc : 0xe7dfc2, { roughness: 0.72 }), [0, 48, isWash ? 27.8 : 23.8]), "bottle-label", "label");
  if (isWash) {
    addTube(group, [[0, 109, 0], [0, 138, 0], [-20, 150, 0], [-38, 147, 0]], 3.2, standardMaterial(0xe8ebe7, { roughness: 0.32 }), "wash-bottle-spout", 20);
  }
  return setObjectMetadata(group, { heightMm: isWash ? 153 : 110, footprintMm: isWash ? [60, 60] : [64, 52], sockets: { pour: isWash ? [-38, 147, 0] : [0, 109, 0], grip: [0, 48, 0], attach: [0, 0, 0] }, attachmentAnchors: { grip: [0, 48, 0], attach: [0, 0, 0] }, visualVariant, referenceAsset: isWash ? APPARATUS_REFERENCE_ASSETS.wash_bottle : APPARATUS_REFERENCE_ASSETS.bottle });
}

function createSpectrophotometer() {
  const group = new THREE.Group();
  const shell = standardMaterial(0xe9e7e0, { roughness: 0.38 });
  const panel = standardMaterial(0x343c40, { roughness: 0.34 });
  markComponent(addRoundedBox(group, [180, 52, 120], 14, standardMaterial(0x222a2e, { roughness: 0.58 }), [0, 26, 0]), "spectrophotometer-base", "base");
  markComponent(addRoundedBox(group, [174, 42, 112], 13, shell, [0, 58, -2]), "spectrophotometer-shell", "housing");
  markComponent(addRoundedBox(group, [78, 34, 4], 6, panel, [-43, 70, 54], [-0.16, 0, 0]), "spectrophotometer-control-panel", "control-panel");
  markComponent(addRoundedBox(group, [54, 17, 2], 3, standardMaterial(0x172426, { emissive: 0x365e59, emissiveIntensity: 0.2 }), [-48, 76, 57], [-0.16, 0, 0]), "display", "display");
  [0x4ca75d, 0xe2b73c, 0xc24a4d, 0xd5d6d2].forEach((color, index) => markComponent(addCylinder(group, [6.5, 6.5], 3, standardMaterial(color, { roughness: 0.38 }), [-69 + index * 20, 55, 58], [Math.PI / 2, 0, 0], 20), `spectrophotometer-button-${index + 1}`, "control"));
  const bay = new THREE.Group();
  bay.name = "sample-bay";
  bay.userData.componentRole = "insertion-bay";
  markComponent(addBox(bay, [35, 4, 38], standardMaterial(0x111619, { roughness: 0.75 }), [0, 0, 0]), "sample-bay-floor", "bay-floor");
  [[-20, 17, 0, 5, 38, 46], [20, 17, 0, 5, 38, 46], [0, 17, -21, 35, 38, 5], [0, 17, 21, 35, 38, 5]].forEach(([x, y, z, w, h, d]) => addBox(bay, [w, h, d], panel, [x, y, z]));
  const sampleSlot = new THREE.Group();
  sampleSlot.name = "sample-slot";
  sampleSlot.userData.componentRole = "sample-slot";
  [[-9, 14, 0, 2, 28, 18], [9, 14, 0, 2, 28, 18], [0, 14, -9, 16, 28, 2], [0, 14, 9, 16, 28, 2]].forEach(([x, y, z, w, h, d]) => addBox(sampleSlot, [w, h, d], standardMaterial(0x070a0c, { roughness: 0.82 }), [x, y, z]));
  bay.add(sampleSlot);
  bay.position.set(50, 68, 2);
  group.add(bay);
  const lid = markComponent(addRoundedBox(group, [72, 7, 57], 5, shell, [50, 109, -22], [-1.02, 0, 0]), "sample-bay-lid", "open-lid");
  lid.userData.open = true;
  return setObjectMetadata(group, { heightMm: 130, footprintMm: [184, 124], sockets: { insert: [50, 70, 2], place: [50, 108, 2] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.instrument });
}

function createDryingOven() {
  const group = new THREE.Group();
  const steel = standardMaterial(COLORS.brushedMetal, { roughness: 0.3, metalness: 0.62 });
  const panel = standardMaterial(0x333a3e, { roughness: 0.42 });
  const inner = standardMaterial(0x4b5052, { roughness: 0.4, metalness: 0.42 });
  markComponent(addRoundedBox(group, [194, 14, 138], 5, steel, [0, 15, 0]), "oven-floor-shell", "cabinet");
  markComponent(addRoundedBox(group, [194, 14, 138], 5, steel, [0, 145, 0]), "oven-top-shell", "cabinet");
  markComponent(addBox(group, [14, 118, 138], steel, [-90, 80, 0]), "oven-left-shell", "cabinet");
  markComponent(addBox(group, [42, 118, 138], steel, [76, 80, 0]), "oven-control-column-shell", "cabinet");
  markComponent(addBox(group, [132, 118, 10], inner, [-17, 80, -64]), "oven-chamber-back", "chamber");
  markComponent(addBox(group, [126, 5, 112], inner, [-18, 29, 0]), "oven-chamber-floor", "chamber-floor");
  [55, 88].forEach((y) => markComponent(addBox(group, [120, 3, 108], standardMaterial(0x777d7f, { roughness: 0.36, metalness: 0.52 }), [-18, y, 0]), `oven-shelf-${y}`, "shelf"));
  const door = new THREE.Group();
  door.name = "oven-door";
  door.userData.componentRole = "door";
  door.userData.open = true;
  markComponent(addRoundedBox(door, [132, 112, 7], 7, steel, [66, 0, 0]), "oven-door-panel", "door-panel");
  markComponent(addRoundedBox(door, [96, 73, 3], 8, standardMaterial(0x151c20, { roughness: 0.2, transparent: true, opacity: 0.72 }), [61, 3, 4]), "oven-door-window", "window");
  markComponent(addCylinder(door, [4, 4], 72, steel, [118, 0, 9]), "oven-door-handle", "handle");
  door.position.set(-84, 80, 69);
  door.rotation.y = -1.18;
  group.add(door);
  markComponent(addRoundedBox(group, [34, 104, 4], 3, panel, [76, 80, 70]), "oven-control-panel", "control-panel");
  markComponent(addCylinder(group, [10, 10], 5, standardMaterial(0xa7aaab, { roughness: 0.24, metalness: 0.62 }), [76, 78, 74], [Math.PI / 2, 0, 0], 24), "oven-dial", "control");
  markComponent(addCylinder(group, [4, 4], 4, standardMaterial(0x2da56c, { emissive: 0x1f9d60, emissiveIntensity: 0.35 }), [76, 113, 74], [Math.PI / 2, 0, 0], 16), "status-light", "status-light");
  markComponent(addRoundedBox(group, [17, 22, 4], 2, standardMaterial(0x171b1d, { roughness: 0.62 }), [76, 46, 74]), "oven-power-switch", "control");
  [-78, 78].forEach((x) => [-52, 52].forEach((z) => markComponent(addCylinder(group, [8, 8], 8, standardMaterial(COLORS.black), [x, 4, z]), "oven-foot", "foot")));
  return setObjectMetadata(group, { heightMm: 152, footprintMm: [260, 190], sockets: { insert: [-18, 57, 38], place: [-18, 57, 38] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.oven });
}

function createCoolingRack() {
  const group = new THREE.Group();
  const metal = standardMaterial(COLORS.metal, { roughness: 0.34, metalness: 0.65 });
  const ceramic = standardMaterial(0xd7d2c6, { roughness: 0.82 });
  [-60, 60].forEach((x) => markComponent(addBox(group, [6, 8, 94], metal, [x, 5, 0]), "gauze-frame", "frame"));
  [-44, 44].forEach((z) => markComponent(addBox(group, [120, 8, 6], metal, [0, 5, z]), "gauze-frame", "frame"));
  for (let x = -48; x <= 48; x += 12) markComponent(addCylinder(group, [1.2, 1.2], 82, metal, [x, 11, 0], [Math.PI / 2, 0, 0], 10), "gauze-wire", "wire");
  for (let z = -36; z <= 36; z += 12) markComponent(addCylinder(group, [1.2, 1.2], 108, metal, [0, 11, z], [0, 0, Math.PI / 2], 10), "gauze-wire", "wire");
  markComponent(addCylinder(group, [30, 30], 3, ceramic, [0, 13, 0], [0, 0, 0], 40), "gauze-ceramic-center", "heat-diffuser");
  return setObjectMetadata(group, { heightMm: 16, footprintMm: [130, 98], sockets: { place: [0, 16, 0] }, referenceAsset: "wire-gauze.png" });
}

function createRack(id, visualVariant = "standard") {
  const group = new THREE.Group();
  const locked = id.includes("locked") || visualVariant.includes("locked");
  const plastic = standardMaterial(locked ? COLORS.carrier : 0xe5e2d9, { roughness: 0.46 });
  const holes = [];
  for (let row = -1; row <= 1; row += 1) for (let column = -2.5; column <= 2.5; column += 1) holes.push([column * 21, row * 22, 8.5]);
  markComponent(addMesh(group, perforatedPlateGeometry(132, 76, 7, holes), plastic, [0, 4, 0]), "rack-lower-deck", "perforated-deck");
  markComponent(addMesh(group, perforatedPlateGeometry(132, 76, 7, holes), plastic, [0, 54, 0]), "rack-upper-deck", "perforated-deck");
  [-59, 59].forEach((x) => [-31, 31].forEach((z) => markComponent(addRoundedBox(group, [6, 49, 6], 2, plastic, [x, 29, z]), "rack-support", "support")));
  if (locked) {
    const lid = markComponent(addRoundedBox(group, [139, 8, 83], 7, standardMaterial(COLORS.carrierDark, { roughness: 0.5, transparent: true, opacity: 0.86 }), [0, 63, 0]), "rack-secured-lid", "secured-lid");
    lid.userData.locked = true;
    [-45, 45].forEach((x) => markComponent(addBox(group, [18, 12, 5], standardMaterial(COLORS.brushedMetal, { roughness: 0.28, metalness: 0.58 }), [x, 61, 43]), "carrier-latch", "latch"));
  }
  return setObjectMetadata(group, { heightMm: locked ? 68 : 62, footprintMm: [142, 86], sockets: { insert: [0, locked ? 70 : 62, 0], place: [0, locked ? 70 : 64, 0], grip: [0, 58, 0], attach: [0, 0, 0] }, attachmentAnchors: { grip: [0, 58, 0], attach: [0, 0, 0] }, visualVariant, referenceAsset: APPARATUS_REFERENCE_ASSETS.rack });
}

function createCarrier(id, visualVariant = "standard") {
  const formVariant = ["rack", "bin", "tote", "tray", "carrier"].includes(visualVariant) ? visualVariant : id.includes("rack") ? "rack" : id.includes("bin") ? "bin" : id.includes("tote") ? "tote" : id.includes("tray") ? "tray" : "carrier";
  const contentVariant = id.includes("waste") ? "waste" : id.includes("cool") ? "cooled" : id.includes("drying") || id.includes("hot") ? "thermal" : id.includes("filter") || id.includes("supply") || id.includes("gravimetry") ? "filtration" : id.includes("reagent") || id.includes("stock") ? "reagent" : id.includes("sample") || id.includes("blank") ? "sample" : id.includes("queue") ? "queue" : id.includes("empty") ? "empty" : "standard";
  if (formVariant === "rack") {
    const rack = createRack(id, "locked");
    const handleMaterial = standardMaterial(COLORS.carrierDark, { roughness: 0.5 });
    [[-76, "left"], [76, "right"]].forEach(([x, side]) => {
      const handle = addTube(rack, [[x, 23, -21], [x + (x < 0 ? -9 : 9), 40, -11], [x + (x < 0 ? -9 : 9), 40, 11], [x, 23, 21]], 4.2, handleMaterial, `carrier-${side}-handle`, 18);
      handle.userData.componentRole = "grasp-handle";
    });
    rack.userData.footprintMm = [176, 90];
    rack.userData.sockets = { ...rack.userData.sockets, grip: [0, 40, 0], leftGrip: [-85, 40, 0], rightGrip: [85, 40, 0], attach: [0, 0, 0] };
    rack.userData.attachmentAnchors = { grip: [0, 40, 0], leftGrip: [-85, 40, 0], rightGrip: [85, 40, 0], attach: [0, 0, 0] };
    rack.userData.visualVariant = "rack";
    rack.userData.carrierContents = contentVariant;
    rack.userData.referenceAsset = APPARATUS_REFERENCE_ASSETS.rack;
    return rack;
  }
  const group = new THREE.Group();
  const bodyColor = contentVariant === "waste" ? COLORS.danger : contentVariant === "thermal" ? COLORS.warning : contentVariant === "cooled" ? 0x3f7385 : contentVariant === "reagent" ? 0x53735a : contentVariant === "filtration" ? 0x516f82 : COLORS.carrier;
  const body = standardMaterial(bodyColor, { roughness: 0.42 });
  const dark = standardMaterial(COLORS.carrierDark, { roughness: 0.52 });
  const bodyHeight = formVariant === "tray" ? 30 : formVariant === "bin" ? 70 : formVariant === "tote" ? 60 : contentVariant === "empty" ? 32 : 58;
  const bodyWidth = formVariant === "tote" ? 164 : 152;
  const bodyDepth = formVariant === "bin" ? 118 : 108;
  markComponent(addRoundedBox(group, [bodyWidth, bodyHeight, bodyDepth], 9, body, [0, bodyHeight / 2, 0]), `${formVariant}-body`, "secured-body");
  const lid = markComponent(addRoundedBox(group, [bodyWidth + 6, 9, bodyDepth + 6], 8, dark, [0, bodyHeight + 4.5, 0]), "carrier-lid", "secured-lid");
  lid.userData.secured = true;
  const labelColor = contentVariant === "waste" ? 0xffe0d1 : contentVariant === "thermal" ? 0xffedc2 : 0xe6e4d8;
  markComponent(addRoundedBox(group, [78, 28, 3], 3, standardMaterial(labelColor, { roughness: 0.74 }), [0, Math.max(23, bodyHeight * 0.62), 55]), "carrier-identity-panel", "identity-panel");
  [-48, 48].forEach((x) => markComponent(addRoundedBox(group, [22, 15, 7], 2, standardMaterial(0x9ca7aa, { roughness: 0.25, metalness: 0.55 }), [x, bodyHeight - 2, 58]), "carrier-latch", "latch"));
  const handles = [[-76, "left"], [76, "right"]];
  handles.forEach(([x, side]) => {
    const handle = addTube(group, [[x, 24, -22], [x + (x < 0 ? -10 : 10), 42, -12], [x + (x < 0 ? -10 : 10), 42, 12], [x, 24, 22]], 4.5, dark, `carrier-${side}-handle`, 18);
    handle.userData.componentRole = "grasp-handle";
  });
  if (contentVariant === "reagent" || contentVariant === "sample") {
    const insert = new THREE.Group();
    insert.name = "carrier-load-indicator";
    insert.userData.componentRole = "sealed-load-cue";
    [-42, -14, 14, 42].forEach((x, index) => {
      addCylinder(insert, [9, 9], 9, standardMaterial([0x9d4a3f, 0xd19b38, 0x4a7d64, 0x426f9c][index], { roughness: 0.34 }), [x, 0, 0]);
      addTorus(insert, 10, 1.2, standardMaterial(0xd7dad4, { roughness: 0.38 }), [x, 5, 0]);
    });
    insert.position.y = bodyHeight + 8;
    group.add(insert);
  } else if (contentVariant === "filtration") {
    const windowMaterial = standardMaterial(0xabcbd0, { roughness: 0.14, transparent: true, opacity: 0.48 });
    markComponent(addRoundedBox(group, [92, 3, 54], 7, windowMaterial, [0, bodyHeight + 9, 0]), "carrier-load-window", "secured-window");
    markComponent(addCylinder(group, [20, 20], 2, standardMaterial(COLORS.paper, { roughness: 0.9 }), [-27, bodyHeight + 8, 0]), "carrier-filter-cue", "sealed-load-cue");
    markComponent(addCylinder(group, [15, 15], 4, standardMaterial(COLORS.ceramic, { roughness: 0.35 }), [27, bodyHeight + 8, 0]), "carrier-funnel-cue", "sealed-load-cue");
  } else if (contentVariant === "waste") {
    markComponent(addBox(group, [54, 5, 54], standardMaterial(0x5b1e26, { roughness: 0.58 }), [0, bodyHeight + 9, 0], [0, Math.PI / 4, 0]), "carrier-waste-mark", "hazard-mark");
  } else if (contentVariant === "queue") {
    [-42, 0, 42].forEach((x, index) => markComponent(addBox(group, [6, 7 + index * 2, 76], standardMaterial(0x97aaa8, { roughness: 0.56 }), [x, bodyHeight + 8, 0]), `carrier-queue-divider-${index + 1}`, "queue-marker"));
  }
  const heightMm = bodyHeight + 17;
  return setObjectMetadata(group, {
    heightMm,
    footprintMm: [Math.max(178, bodyWidth + 26), bodyDepth + 10],
    sockets: { place: [0, heightMm + 2, 0], grip: [0, 39, 0], leftGrip: [-86, 39, 0], rightGrip: [86, 39, 0], attach: [0, 0, 0] },
    attachmentAnchors: { grip: [0, 39, 0], leftGrip: [-86, 39, 0], rightGrip: [86, 39, 0], attach: [0, 0, 0] },
    visualVariant: formVariant,
    referenceAsset: APPARATUS_REFERENCE_ASSETS.secured_carrier
  });
}

function createChromatographyChamber() {
  const group = new THREE.Group();
  const glass = glassMaterial(0.32);
  addBox(group, [96, 126, 68], glass, [0, 63, 0]);
  addBox(group, [104, 8, 76], glass, [0, 132, 0]);
  addCylinder(group, [16, 16], 15, glass, [0, 143, 0]);
  addBox(group, [82, 7, 56], standardMaterial(COLORS.liquid, { transparent: true, opacity: 0.24, roughness: 0.18 }), [0, 8, 0]);
  return setObjectMetadata(group, { heightMm: 152, footprintMm: [108, 80], sockets: { insert: [0, 24, 0], place: [0, 24, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.chromatography_chamber });
}

function createVacuumSource() {
  const group = new THREE.Group();
  const shell = standardMaterial(0xe5e8e4, { roughness: 0.38, metalness: 0.08 });
  markComponent(addRoundedBox(group, [124, 72, 84], 10, shell, [0, 40, 0]), "vacuum-pump-shell", "housing");
  markComponent(addRoundedBox(group, [78, 29, 3], 4, standardMaterial(0x1c2427, { roughness: 0.42 }), [-5, 46, 43]), "vacuum-control-panel", "control-panel");
  const gauge = markComponent(addCylinder(group, [14, 14], 5, standardMaterial(0xd7dcdb, { roughness: 0.3 }), [-20, 48, 46], [Math.PI / 2, 0, 0], 28), "vacuum-gauge", "display");
  gauge.userData.simulatedReadout = true;
  markComponent(addBox(group, [1.5, 10, 1.5], standardMaterial(0x27343a, { roughness: 0.38 }), [-20, 48, 49], [0, 0, -0.55]), "vacuum-gauge-needle", "indicator");
  markComponent(addCylinder(group, [5, 5], 4, standardMaterial(0x45a470, { emissive: 0x2a8e5c, emissiveIntensity: 0.25 }), [-47, 47, 45], [Math.PI / 2, 0, 0], 18), "status-light", "status-light");
  markComponent(addCylinder(group, [8, 8], 20, standardMaterial(COLORS.metal, { roughness: 0.25, metalness: 0.65 }), [48, 42, 45], [Math.PI / 2, 0, 0], 22), "vacuum-port", "vacuum-port");
  const hose = addTube(group, [[48, 42, 54], [72, 45, 62], [87, 55, 48], [91, 49, 27]], 4.4, standardMaterial(0x26373b, { roughness: 0.68 }), "vacuum-hose", 28);
  hose.userData.connected = false;
  addTube(group, [[-38, 77, -22], [-38, 101, -22], [38, 101, -22], [38, 77, -22]], 5, standardMaterial(0x2d383c, { roughness: 0.48 }), "vacuum-handle", 24);
  for (let index = -3; index <= 3; index += 1) markComponent(addBox(group, [2, 20, 25], standardMaterial(0x263237, { roughness: 0.72 }), [-62.5, 39 + index * 6, -5]), "vacuum-vent", "vent");
  [-48, 48].forEach((x) => [-29, 29].forEach((z) => markComponent(addCylinder(group, [6, 6], 7, standardMaterial(COLORS.black, { roughness: 0.78 }), [x, 3.5, z]), "vacuum-foot", "foot")));
  return setObjectMetadata(group, { heightMm: 106, footprintMm: [188, 116], sockets: { vacuum: [91, 49, 27], hoseEnd: [91, 49, 27], operate: [-47, 47, 45] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.vacuum_source });
}

function createWashStation() {
  const group = new THREE.Group();
  const steel = standardMaterial(COLORS.brushedMetal, { roughness: 0.28, metalness: 0.7 });
  addBox(group, [166, 20, 116], standardMaterial(0xd7d8d3, { roughness: 0.42 }), [0, 10, 0]);
  addBox(group, [106, 12, 72], steel, [0, 18, 0]);
  addBox(group, [90, 9, 58], standardMaterial(0x58666b, { roughness: 0.32, metalness: 0.38 }), [0, 18, 0]);
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(46, 22, -30), new THREE.Vector3(46, 82, -30), new THREE.Vector3(10, 94, -12), new THREE.Vector3(0, 70, 0)]);
  addMesh(group, new THREE.TubeGeometry(curve, 22, 4, 12, false), steel);
  return setObjectMetadata(group, { heightMm: 98, footprintMm: [170, 120], sockets: { operate: [0, 34, 0] }, referenceAsset: APPARATUS_REFERENCE_ASSETS.wash_bottle });
}

function createTool(id) {
  const group = new THREE.Group();
  if (id.includes("spatula")) {
    const metal = standardMaterial(COLORS.brushedMetal, { roughness: 0.28, metalness: 0.74 });
    markComponent(addCylinder(group, [2.4, 2.4], 94, metal, [0, 8, 0], [0, 0, Math.PI / 2], 14), "spatula-shaft", "grasp-shaft");
    markComponent(addMesh(group, new THREE.CapsuleGeometry(6, 27, 5, 12), metal, [66, 8, 0], [0, 0, Math.PI / 2]), "spatula-blade", "transfer-blade");
    markComponent(addBox(group, [26, 1.8, 8], metal, [-60, 8, 0]), "spatula-micro-blade", "transfer-blade");
  } else {
    markComponent(addCylinder(group, [1.45, 0.65], 124, glassMaterial(0.44), [0, 8, 0], [0, 0, Math.PI / 2], 14, true), "capillary-tube", "capillary");
    markComponent(addCylinder(group, [1.6, 1.6], 12, standardMaterial(0x315f98, { transparent: true, opacity: 0.68, roughness: 0.18 }), [57, 8, 0], [0, 0, Math.PI / 2], 12), "capillary-sample", "configured-sample");
    markComponent(addCylinder(group, [3.4, 3.4], 28, standardMaterial(0xe8e2d2, { roughness: 0.62 }), [-18, 8, 0], [0, 0, Math.PI / 2], 14), "capillary-grip", "grasp-surface");
  }
  return setObjectMetadata(group, { heightMm: 18, footprintMm: [150, 18], sockets: { grip: [-18, 8, 0], attach: [0, 8, 0] }, attachmentAnchors: { grip: [-18, 8, 0], attach: [0, 8, 0] }, referenceAsset: id.includes("spatula") ? "lab-scoop.png" : "capillary-spotter.png" });
}

function createFallback(id) {
  const group = new THREE.Group();
  addBox(group, [72, 52, 62], standardMaterial(COLORS.neutral), [0, 26, 0]);
  addBox(group, [46, 20, 2], standardMaterial(0xe6e2d7), [0, 30, 32]);
  return setObjectMetadata(group, { heightMm: 54, footprintMm: [76, 66], sockets: { place: [0, 56, 0] }, referenceAsset: "unmatched-approximation", id });
}

export function referenceAssetFor(definition) {
  if (definition.type === "flask" && definition.id.includes("volumetric")) return APPARATUS_REFERENCE_ASSETS.volumetric_flask;
  if (definition.type === "bottle" && definition.id.includes("wash")) return APPARATUS_REFERENCE_ASSETS.wash_bottle;
  return APPARATUS_REFERENCE_ASSETS[definition.type] || "unmatched-approximation";
}

export function createApparatusObject(definition) {
  let visual;
  const visualVariant = definition.visualVariant || "standard";
  switch (definition.type) {
    case "balance": visual = createBalance(); break;
    case "watch_glass": visual = createWatchGlass(); break;
    case "weigh_boat": visual = createWeighBoat(); break;
    case "beaker": visual = createBeaker(); break;
    case "cylinder": visual = createGraduatedCylinder(); break;
    case "flask": visual = definition.id.includes("volumetric") ? createVolumetricFlask() : createErlenmeyerFlask(); break;
    case "filter_flask": visual = createFilterFlask(); break;
    case "stopper": visual = createStopper(); break;
    case "cuvette": visual = createCuvette(); break;
    case "filter_paper": visual = createFilterPaper(visualVariant); break;
    case "chromatography_paper": visual = createChromatographyPaper(); break;
    case "funnel": visual = createGravityFunnel(); break;
    case "buchner_funnel": visual = createBuchnerFunnel(); break;
    case "separatory_funnel": visual = createSeparatoryFunnel(); break;
    case "burette": visual = createBuretteAssembly(); break;
    case "stand": visual = createRingStand(); break;
    case "pipette": visual = createPipette(); break;
    case "pipette_pump": visual = createPipettePump(); break;
    case "bottle": visual = createBottle(definition.id, visualVariant); break;
    case "instrument": visual = createSpectrophotometer(); break;
    case "oven": visual = createDryingOven(); break;
    case "cooling_rack": visual = createCoolingRack(); break;
    case "rack": visual = createRack(definition.id, visualVariant); break;
    case "secured_carrier": visual = createCarrier(definition.id, visualVariant); break;
    case "chromatography_chamber": visual = createChromatographyChamber(); break;
    case "vacuum_source": visual = createVacuumSource(); break;
    case "wash_station": visual = createWashStation(); break;
    case "queue_station": visual = createRack(definition.id, visualVariant); break;
    case "tool": visual = createTool(definition.id); break;
    default: visual = createFallback(definition.id);
  }
  visual.name = `lab-object-${definition.id}`;
  visual.userData.labObjectId = definition.id;
  visual.userData.referenceAsset = definition.visualReference || referenceAssetFor(definition);
  visual.userData.visualVariant = visualVariant === "standard" ? visual.userData.visualVariant || "standard" : visualVariant;
  return visual;
}

export function objectSocket(object, socketName = "place") {
  const raw = object?.userData?.sockets?.[socketName] || object?.userData?.sockets?.place || [0, object?.userData?.heightMm || 0, 0];
  return new THREE.Vector3(...raw);
}

export function disposeObject3D(root) {
  if (!root) return;
  const disposedGeometries = new Set();
  const disposedMaterials = new Set();
  const disposedTextures = new Set();
  root.traverse((object) => {
    if (object.geometry && !disposedGeometries.has(object.geometry)) {
      disposedGeometries.add(object.geometry);
      object.geometry.dispose?.();
    }
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.filter(Boolean).forEach((item) => {
      if (item.map && !disposedTextures.has(item.map)) {
        disposedTextures.add(item.map);
        item.map.dispose?.();
      }
      if (!disposedMaterials.has(item)) {
        disposedMaterials.add(item);
        item.dispose?.();
      }
    });
  });
}
