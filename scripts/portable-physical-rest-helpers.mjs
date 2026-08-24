import { PHYSICAL_REST_SCHEMA } from "../lab/v2/physical-rest.js";
import { APPARATUS_RADIAL_PROFILES } from "../lab/v2/apparatus-geometry.js";

export const WORLD_UP = Object.freeze([0, 1, 0]);
export const IDENTITY_ROTATION = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);
export const YAW_90_ROTATION = Object.freeze([0, 0, 1, 0, 1, 0, -1, 0, 0]);
export const YAW_180_ROTATION = Object.freeze([-1, 0, 0, 0, 1, 0, 0, 0, -1]);

const configuredClaim = (name, dimensions) => (
  `C: configured ${name} envelope (${dimensions}) follows the procedural apparatus renderer; `
  + "the lab item is grasped directly and is not carried in a tray, carrier, cassette, bin, or proxy box"
);

const profile = (settings) => Object.freeze({
  localUp: WORLD_UP,
  maxTiltDeg: 2,
  ...settings,
  footprintMm: Object.freeze([...settings.footprintMm]),
  gripSocketMm: Object.freeze([...settings.gripSocketMm]),
  centerOfMassLocalMm: Object.freeze([...settings.centerOfMassLocalMm]),
  geometry: Object.freeze({
    type: settings.geometry.type || "box",
    ...(settings.geometry.footprintShape ? { footprintShape: settings.geometry.footprintShape } : {}),
    ...(settings.geometry.radialProfileMm ? { radialProfileMm: Object.freeze(settings.geometry.radialProfileMm.map((point) => Object.freeze([...point]))) } : {}),
    centerLocalMm: Object.freeze([...settings.geometry.centerLocalMm]),
    halfExtentsMm: Object.freeze([...settings.geometry.halfExtentsMm]),
    ...(settings.geometry.collisionParts ? { collisionParts: Object.freeze(settings.geometry.collisionParts.map((part) => Object.freeze(part.shape === "capsule" ? {
      shape: "capsule",
      startLocalMm: Object.freeze([...part.startLocalMm]),
      endLocalMm: Object.freeze([...part.endLocalMm]),
      radiusMm: part.radiusMm,
    } : {
      type: part.type || "box",
      ...(part.footprintShape ? { footprintShape: part.footprintShape } : {}),
      centerLocalMm: Object.freeze([...part.centerLocalMm]),
      halfExtentsMm: Object.freeze([...part.halfExtentsMm]),
    }))) } : {}),
  }),
});

const PROFILES = Object.freeze({
  watch_glass: profile({
    type: "watch_glass", variant: "flat", directLabel: "150 mm watch glass", heightMm: 14.286,
    footprintMm: [150, 150], gripSocketMm: [-69, 8.929, 0], renderGripSocketMm: [-69, 5, 0], centerOfMassLocalMm: [0, 5.357, 0],
    geometry: { type: "box", footprintShape: "ellipse", centerLocalMm: [0, 7.143, 0], halfExtentsMm: [75, 7.143, 75] },
    gripInterface: "direct rim pinch at the bounded worktop overhang", supportKind: "flat_watch_glass_on_real_work_surface",
    supportPolicy: { mode: "center_of_mass_projection", minimumSupportedFraction: 0.58 },
    maxPenetrationMm: 1.5,
    scale: 150 / 84,
    claim: "F/C: United Scientific S00852 150 mm soda-lime watch glass with polished edges; the procedural 84 mm renderer is uniformly scaled to the documented diameter and retains a configured 14.286 mm curved envelope; https://www.fishersci.com/shop/products/watch-glass-79/S00852",
  }),
  spatula: profile({
    type: "tool", variant: "spatula", directLabel: "Spatula", heightMm: 18,
    footprintMm: [150, 18], gripSocketMm: [-18, 8, 0], centerOfMassLocalMm: [0, 8, 0],
    geometry: { centerLocalMm: [0, 9, 0], halfExtentsMm: [75, 9, 9] },
    gripInterface: "direct shaft pinch", supportKind: "flat_spatula_on_real_work_surface",
    claim: configuredClaim("flat laboratory spatula", "150 x 18 x 18 mm"),
  }),
  capillary: profile({
    type: "tool", variant: "capillary", directLabel: "Capped spotting capillary", heightMm: 18,
    footprintMm: [150, 18], gripSocketMm: [-18, 8, 0], centerOfMassLocalMm: [0, 8, 0],
    geometry: { centerLocalMm: [0, 9, 0], halfExtentsMm: [75, 9, 9] },
    gripInterface: "direct padded-grip pinch", supportKind: "flat_capillary_tool_on_real_work_surface",
    claim: configuredClaim("capped spotting capillary", "150 x 18 x 18 mm"),
  }),
  weigh_boat: profile({
    type: "weigh_boat", variant: "standard", directLabel: "Weigh boat", heightMm: 12,
    footprintMm: [74, 58], gripSocketMm: [34, 7, 0], centerOfMassLocalMm: [0, 4, 0],
    geometry: { centerLocalMm: [0, 6, 0], halfExtentsMm: [37, 6, 29] },
    gripInterface: "direct raised-lip pinch", supportKind: "weigh_boat_on_real_work_surface",
    claim: configuredClaim("weigh-boat", "74 x 12 x 58 mm"),
  }),
  beaker: profile({
    type: "beaker", variant: "standard", directLabel: "Empty beaker", heightMm: 80,
    footprintMm: [74, 74], gripSocketMm: [0, 73, 31], centerOfMassLocalMm: [0, 38, 0],
    geometry: {
      footprintShape: "ellipse", centerLocalMm: [0, 40, 0], halfExtentsMm: [37, 40, 37],
    },
    gripInterface: "direct rim wall pinch", supportKind: "upright_beaker_on_real_work_surface",
    claim: configuredClaim("empty beaker", "74 x 80 x 74 mm"),
  }),
  flask: profile({
    type: "flask", variant: "erlenmeyer", directLabel: "Empty Erlenmeyer flask", heightMm: 114,
    footprintMm: [80, 80], gripSocketMm: [0, 96, 0], centerOfMassLocalMm: [0, 42, 0],
    geometry: {
      radialProfileMm: APPARATUS_RADIAL_PROFILES.erlenmeyer,
      centerLocalMm: [0, 57, 0], halfExtentsMm: [40, 57, 40],
      collisionParts: [
        { footprintShape: "ellipse", centerLocalMm: [0, 27.5, 0], halfExtentsMm: [40, 27.5, 40] },
        { footprintShape: "ellipse", centerLocalMm: [0, 69, 0], halfExtentsMm: [31, 14, 31] },
        { footprintShape: "ellipse", centerLocalMm: [0, 97.5, 0], halfExtentsMm: [15, 14.5, 15] },
      ],
    },
    gripInterface: "direct neck pinch", supportKind: "upright_flask_on_real_work_surface",
    claim: configuredClaim("empty Erlenmeyer flask", "80 x 114 x 80 mm"),
  }),
  volumetric_flask: profile({
    type: "flask", variant: "volumetric", directLabel: "Empty volumetric flask", heightMm: 154,
    footprintMm: [72, 72], gripSocketMm: [0, 116, 0], centerOfMassLocalMm: [0, 52, 0],
    geometry: {
      radialProfileMm: APPARATUS_RADIAL_PROFILES.volumetricFlask,
      centerLocalMm: [0, 77, 0], halfExtentsMm: [36, 77, 36],
      collisionParts: [
        { footprintShape: "ellipse", centerLocalMm: [0, 31.5, 0], halfExtentsMm: [35, 31.5, 35] },
        { footprintShape: "ellipse", centerLocalMm: [0, 69.5, 0], halfExtentsMm: [17, 6.5, 17] },
        { footprintShape: "ellipse", centerLocalMm: [0, 113.5, 0], halfExtentsMm: [10, 37.5, 10] },
      ],
    },
    gripInterface: "direct neck pinch", supportKind: "upright_volumetric_flask_on_real_work_surface",
    claim: configuredClaim("empty volumetric flask", "72 x 154 x 72 mm"),
  }),
  filter_flask: profile({
    type: "filter_flask", variant: "standard", directLabel: "Empty filter flask", heightMm: 114,
    footprintMm: [104, 80], gripSocketMm: [0, 96, 0], centerOfMassLocalMm: [4, 42, 0],
    geometry: {
      centerLocalMm: [10, 57, 0], halfExtentsMm: [52, 57, 40],
      collisionParts: [
        { footprintShape: "ellipse", centerLocalMm: [0, 27.5, 0], halfExtentsMm: [40, 27.5, 40] },
        { footprintShape: "ellipse", centerLocalMm: [0, 69, 0], halfExtentsMm: [31, 14, 31] },
        { footprintShape: "ellipse", centerLocalMm: [0, 97.5, 0], halfExtentsMm: [15, 14.5, 15] },
        { centerLocalMm: [38, 82, 0], halfExtentsMm: [26, 14, 9] },
      ],
    },
    gripInterface: "direct neck pinch clear of side arm", supportKind: "upright_filter_flask_on_real_work_surface",
    claim: configuredClaim("empty side-arm filter flask", "104 x 114 x 80 mm"),
  }),
  cuvette: profile({
    type: "cuvette", variant: "capped", directLabel: "Capped sample cuvette", heightMm: 55,
    footprintMm: [20, 20], gripSocketMm: [0, 44, 0], centerOfMassLocalMm: [0, 25, 0],
    geometry: { centerLocalMm: [0, 27.5, 0], halfExtentsMm: [10, 27.5, 10] },
    gripInterface: "direct upper-body pinch", supportKind: "upright_cuvette_on_real_work_surface",
    claim: configuredClaim("capped practice cuvette", "20 x 55 x 20 mm"),
  }),
  filter_paper: profile({
    type: "filter_paper", variant: "flat", directLabel: "Dry filter paper", heightMm: 2,
    footprintMm: [62, 62], gripSocketMm: [28, 1, 0], centerOfMassLocalMm: [0, 0.8, 0],
    geometry: { centerLocalMm: [0, 1, 0], halfExtentsMm: [31, 1, 31] },
    gripInterface: "direct edge pinch", supportKind: "flat_filter_paper_on_real_work_surface",
    claim: configuredClaim("flat dry filter paper", "62 x 2 x 62 mm"),
  }),
  funnel: profile({
    type: "funnel", variant: "standard", directLabel: "Dry gravity funnel", heightMm: 112,
    footprintMm: [82, 82], gripSocketMm: [0, 84, 0], centerOfMassLocalMm: [0, 72, 0],
    geometry: { centerLocalMm: [0, 56, 0], halfExtentsMm: [41, 56, 41] },
    gripInterface: "direct cone-body pinch", supportKind: "upright_funnel_in_real_broad_holder",
    claim: configuredClaim("dry gravity funnel", "82 x 112 x 82 mm; stable rest requires the declared real broad holder"),
    requiresHolder: true,
  }),
  buchner_funnel: profile({
    type: "buchner_funnel", variant: "standard", directLabel: "Dry Buchner funnel", heightMm: 98,
    footprintMm: [76, 76], gripSocketMm: [0, 76, 0], centerOfMassLocalMm: [0, 62, 0],
    geometry: { centerLocalMm: [0, 49, 0], halfExtentsMm: [38, 49, 38] },
    gripInterface: "direct cup-body pinch", supportKind: "upright_buchner_funnel_in_real_broad_holder",
    claim: configuredClaim("dry Buchner funnel", "76 x 98 x 76 mm; stable rest requires the declared real broad holder"),
    requiresHolder: true,
  }),
  pipette_pump: profile({
    type: "pipette_pump", variant: "standard", directLabel: "Dry practice pipette pump", heightMm: 108,
    footprintMm: [42, 30], gripSocketMm: [0, 50, 0], centerOfMassLocalMm: [0, 50, 0],
    geometry: { centerLocalMm: [0, 54, 0], halfExtentsMm: [21, 54, 15] },
    gripInterface: "direct housing pinch", supportKind: "upright_pipette_pump_on_real_work_surface",
    claim: configuredClaim("manual pipette pump", "42 x 108 x 30 mm"),
  }),
  bottle: profile({
    type: "bottle", variant: "reagent_bottle", directLabel: "Capped reagent bottle", heightMm: 110,
    footprintMm: [64, 52], gripSocketMm: [0, 48, 0], centerOfMassLocalMm: [0, 46, 0],
    geometry: {
      centerLocalMm: [0, 55, 0], halfExtentsMm: [32, 55, 26],
      collisionParts: [
        { centerLocalMm: [0, 38, 0], halfExtentsMm: [29, 38, 23] },
        { centerLocalMm: [0, 80, 0], halfExtentsMm: [25.5, 5, 20] },
        { footprintShape: "ellipse", centerLocalMm: [0, 87, 0], halfExtentsMm: [17, 6.5, 17] },
        { footprintShape: "ellipse", centerLocalMm: [0, 101, 0], halfExtentsMm: [18, 8, 18] },
      ],
    },
    gripInterface: "direct body pinch", supportKind: "upright_bottle_on_real_work_surface",
    claim: configuredClaim("capped reagent bottle", "64 x 110 x 52 mm"),
  }),
  wash_bottle: profile({
    type: "bottle", variant: "wash_bottle", directLabel: "Capped rinse bottle", heightMm: 153,
    footprintMm: [60, 60], gripSocketMm: [0, 48, 0], centerOfMassLocalMm: [0, 45, 0],
    geometry: {
      centerLocalMm: [0, 76.5, 0], halfExtentsMm: [30, 76.5, 30],
      collisionParts: [
        { footprintShape: "ellipse", centerLocalMm: [0, 38, 0], halfExtentsMm: [27, 38, 27] },
        { footprintShape: "ellipse", centerLocalMm: [0, 87, 0], halfExtentsMm: [17, 6.5, 17] },
        { footprintShape: "ellipse", centerLocalMm: [0, 101, 0], halfExtentsMm: [18, 8, 18] },
        { shape: "capsule", startLocalMm: [0, 109, 0], endLocalMm: [0, 138, 0], radiusMm: 3.2 },
        { shape: "capsule", startLocalMm: [0, 138, 0], endLocalMm: [-20, 150, 0], radiusMm: 3.2 },
        { shape: "capsule", startLocalMm: [-20, 150, 0], endLocalMm: [-38, 147, 0], radiusMm: 3.2 },
      ],
    },
    gripInterface: "direct body pinch clear of spout", supportKind: "upright_wash_bottle_on_real_work_surface",
    claim: configuredClaim("capped rinse bottle", "60 x 153 x 60 mm"),
  }),
  burette_tube: profile({
    type: "burette_tube", variant: "horizontal_capped", directLabel: "Capped dry-practice burette", heightMm: 26,
    footprintMm: [166, 22], gripSocketMm: [0, 13, 0], centerOfMassLocalMm: [0, 13, 0],
    geometry: { centerLocalMm: [0, 13, 0], halfExtentsMm: [83, 13, 11] },
    gripInterface: "direct center-tube pinch", supportKind: "horizontal_capped_burette_on_real_work_surface",
    claim: configuredClaim("capped horizontal dry-practice burette", "166 x 26 x 22 mm"),
  }),
  document_card: profile({
    type: "document_card", variant: "flat", directLabel: "Laboratory record card", heightMm: 6,
    footprintMm: [98, 68], gripSocketMm: [44, 4, 0], centerOfMassLocalMm: [0, 2, 0],
    geometry: { centerLocalMm: [0, 3, 0], halfExtentsMm: [49, 3, 34] },
    gripInterface: "direct card-edge pinch", supportKind: "flat_record_card_on_real_work_surface",
    claim: configuredClaim("flat laboratory record card", "98 x 6 x 68 mm"),
  }),
  chamber_lid: profile({
    type: "chamber_lid", variant: "flat", directLabel: "Development chamber lid", heightMm: 12,
    footprintMm: [112, 82], gripSocketMm: [0, 9, 0], centerOfMassLocalMm: [0, 3, 0],
    geometry: { centerLocalMm: [0, 6, 0], halfExtentsMm: [56, 6, 41] },
    gripInterface: "direct integral lid-handle pinch", supportKind: "flat_chamber_lid_on_real_work_surface",
    claim: configuredClaim("development chamber lid", "112 x 12 x 82 mm"),
  }),
  chromatography_plate: profile({
    type: "chromatography_plate", variant: "flat", directLabel: "Dry chromatography plate", heightMm: 4,
    footprintMm: [90, 66], gripSocketMm: [41, 3, 0], centerOfMassLocalMm: [0, 1.5, 0],
    geometry: { centerLocalMm: [0, 2, 0], halfExtentsMm: [45, 2, 33] },
    gripInterface: "direct plate-edge pinch", supportKind: "flat_chromatography_plate_on_real_work_surface",
    claim: configuredClaim("flat dry chromatography plate", "90 x 4 x 66 mm"),
  }),
  sample_rack: profile({
    type: "sample_rack", variant: "capped", directLabel: "Capped sample rack", heightMm: 86,
    footprintMm: [142, 88], gripSocketMm: [68, 27, 0], centerOfMassLocalMm: [0, 35, 0],
    geometry: { centerLocalMm: [0, 43, 0], halfExtentsMm: [71, 43, 44] },
    gripInterface: "direct rack-side pinch", supportKind: "sample_rack_on_real_work_surface",
    claim: configuredClaim("capped laboratory sample rack", "142 x 86 x 88 mm"),
  }),
});

const PROFILE_RULES = Object.freeze([
  [/watch[_ -]?glass/i, "watch_glass"],
  [/spatula/i, "spatula"],
  [/spotting[_ -]?tool|capillary/i, "capillary"],
  [/weigh[_ -]?boat|dry[_ -]?tray/i, "weigh_boat"],
  [/filter[_ -]?flask/i, "filter_flask"],
  [/volumetric[_ -]?flask/i, "volumetric_flask"],
  [/receiver[_ -]?flask|glassware[_ -]?carrier/i, "flask"],
  [/empty[_ -]?beaker|\bbeaker\b/i, "beaker"],
  [/rinse[_ -]?bottle|wash[_ -]?bottle/i, "wash_bottle"],
  [/reagent[_ -]?bottle|solvent[_ -]?bottle|return[_ -]?carrier|hard[_ -]?water[_ -]?logistics|standard[_ -]?carrier/i, "bottle"],
  [/buchner/i, "buchner_funnel"],
  [/gravity[_ -]?funnel|filling[_ -]?funnel|funnel[_ -]?carrier/i, "funnel"],
  [/filter[_ -]?paper/i, "filter_paper"],
  [/pipette[_ -]?pump/i, "pipette_pump"],
  [/burette/i, "burette_tube"],
  [/chamber[_ -]?lid/i, "chamber_lid"],
  [/dry[_ -]?(?:plate|chromatography)|chromatography[_ -]?(?:plate|supply|kit|bin)/i, "chromatography_plate"],
  [/(?:reference|record|observation)[_ -]?card|station[_ -]?tag/i, "document_card"],
  [/(?:filter[_ -]?cuvette|sample|titration)[_ -]?(?:carrier|rack)|capped[_ -]?(?:reference|sample)?[_ -]?cuvette|sample[_ -]?cuvette|aliquot[_ -]?carrier/i, "cuvette"],
  [/(?:left|right)[_ -]?watch[_ -]?glass/i, "watch_glass"],
  [/(?:left|right)[_ -]?filter[_ -]?flask/i, "filter_flask"],
  [/(?:left|right)[_ -]?volumetric[_ -]?flask/i, "volumetric_flask"],
  [/(?:left|right)[_ -]?wash[_ -]?bottle/i, "wash_bottle"],
  [/(?:left|right)[_ -]?cuvette/i, "cuvette"],
  [/(?:left|right)[_ -]?flask|erlenmeyer/i, "flask"],
  [/(?:left|right)[_ -]?bottle/i, "bottle"],
]);

export function apparatusVisualProfile(item) {
  const description = `${item?.id || ""} ${item?.label || ""}`;
  const configuredProfile = item?.configuredApparatusProfile;
  const match = configuredProfile ? null : PROFILE_RULES.find(([pattern]) => pattern.test(description));
  if (!configuredProfile && !match) throw new Error(`No direct apparatus profile is configured for ${item?.id || "unknown object"}.`);
  const selected = PROFILES[configuredProfile || match[1]];
  if (!selected) throw new Error(`Unknown configured direct apparatus profile ${configuredProfile} for ${item?.id || "unknown object"}.`);
  return {
    ...selected,
    id: item?.id || "configured_apparatus",
    label: selected.directLabel,
    reference: `lab/js/objects.js#${selected.type}`,
  };
}

export function rotate(rotation, vector) {
  return [
    rotation[0] * vector[0] + rotation[1] * vector[1] + rotation[2] * vector[2],
    rotation[3] * vector[0] + rotation[4] * vector[1] + rotation[5] * vector[2],
    rotation[6] * vector[0] + rotation[7] * vector[1] + rotation[8] * vector[2],
  ];
}

export function objectOriginForGrip(gripPositionMm, rotationMatrix, gripSocketMm = [0, 0, 0]) {
  const offset = rotate(rotationMatrix, gripSocketMm);
  return gripPositionMm.map((value, index) => Number(value) - offset[index]);
}

export function directApparatusVisual(item) {
  const apparatus = apparatusVisualProfile(item);
  return {
    type: apparatus.type,
    variant: apparatus.variant,
    reference: apparatus.reference,
    gripSocketMm: [...(apparatus.renderGripSocketMm || apparatus.gripSocketMm)],
    footprintMm: [...apparatus.footprintMm],
    heightMm: apparatus.heightMm,
    ...(Number.isFinite(apparatus.scale) ? { scale: apparatus.scale } : {}),
    directHandling: true,
    containerFree: true,
    approximation: apparatus.claim,
  };
}

export function directHandlingLabel(item) {
  return apparatusVisualProfile(item).directLabel;
}

export function physicalRest({ definition, item, surfaceId, initialSurfaceId = surfaceId, finalSurfaceId = surfaceId, initialFrame, initialGripFrame, finalFrame, finalGripFrame, initialRotation = IDENTITY_ROTATION, finalRotation = initialRotation, gripSocketMm }) {
  const apparatus = apparatusVisualProfile(item);
  const configuredGripSocketMm = Array.isArray(gripSocketMm) ? gripSocketMm : apparatus.gripSocketMm;
  const makePose = (frameId, gripFrameId, rotationMatrix, poseSurfaceId) => ({
    surfaceId: poseSurfaceId,
    graspFrameId: gripFrameId,
    positionMm: objectOriginForGrip(definition.frames[gripFrameId].positionMm, rotationMatrix, configuredGripSocketMm),
    rotationMatrix: [...rotationMatrix],
  });
  return {
    schema: PHYSICAL_REST_SCHEMA,
    supportKind: apparatus.supportKind,
    ...(apparatus.supportPolicy ? { supportPolicy: { ...apparatus.supportPolicy } } : {}),
    sourceRef: apparatus.reference,
    gripSocketMm: [...configuredGripSocketMm],
    gripInterface: apparatus.gripInterface,
    directHandling: true,
    containerFree: true,
    localUp: [...apparatus.localUp],
    centerOfMassLocalMm: [...apparatus.centerOfMassLocalMm],
    geometry: {
      type: apparatus.geometry.type,
      ...(apparatus.geometry.footprintShape ? { footprintShape: apparatus.geometry.footprintShape } : {}),
      ...(apparatus.geometry.radialProfileMm ? { radialProfileMm: apparatus.geometry.radialProfileMm.map((point) => [...point]) } : {}),
      centerLocalMm: [...apparatus.geometry.centerLocalMm],
      halfExtentsMm: [...apparatus.geometry.halfExtentsMm],
      ...(apparatus.geometry.collisionParts ? { collisionParts: apparatus.geometry.collisionParts.map((part) => (part.shape === "capsule" ? {
        ...part,
        startLocalMm: [...part.startLocalMm],
        endLocalMm: [...part.endLocalMm],
      } : {
        ...part,
        centerLocalMm: [...part.centerLocalMm],
        halfExtentsMm: [...part.halfExtentsMm],
      })) } : {}),
      provenance: `${apparatus.claim}; proxy encloses the directly handled apparatus, not a transport container`,
    },
    tolerance: {
      maxTiltDeg: apparatus.maxTiltDeg,
      maxGapMm: 2.5,
      maxPenetrationMm: Number(apparatus.maxPenetrationMm ?? 0.5),
      minimumEdgeMarginMm: 2,
      targetPositionToleranceMm: 12.5,
    },
    poses: {
      [initialFrame]: makePose(initialFrame, initialGripFrame, initialRotation, initialSurfaceId),
      [finalFrame]: makePose(finalFrame, finalGripFrame, finalRotation, finalSurfaceId),
    },
  };
}

export function directGripHeightMm(item) {
  return Number(apparatusVisualProfile(item).gripSocketMm[1]);
}

export function realWorkSurfaceProxy(id, centerMm, halfExtentsMm, provenance) {
  return {
    id,
    type: "box",
    centerMm: [...centerMm],
    halfExtentsMm: [...halfExtentsMm],
    planningRole: "contact_surface",
    physicalSupportSurface: true,
    provenance,
  };
}
