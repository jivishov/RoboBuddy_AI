const freezeProfile = (points) => Object.freeze(points.map((point) => Object.freeze([...point])));

// Shared renderer/contact geometry. Each pair is [radiusMm, heightMm] and is
// consumed by both the Three.js lathe and the SO-101 physical-contact model.
export const APPARATUS_RADIAL_PROFILES = Object.freeze({
  erlenmeyer: freezeProfile([[36, 0], [39, 5], [37, 18], [31, 55], [15, 83], [14, 111]]),
  volumetricFlask: freezeProfile([[29, 0], [34, 4], [35, 20], [31, 42], [17, 63], [9, 76], [9, 151]]),
});

export function radialSurfaceRadiusAtHeight(profile, heightMm) {
  if (!Array.isArray(profile) || profile.length < 2 || !Number.isFinite(Number(heightMm))) return Number.NaN;
  const height = Number(heightMm);
  if (height <= Number(profile[0][1])) return Number(profile[0][0]);
  for (let index = 1; index < profile.length; index += 1) {
    const [priorRadius, priorHeight] = profile[index - 1].map(Number);
    const [nextRadius, nextHeight] = profile[index].map(Number);
    if (height > nextHeight) continue;
    const fraction = Math.max(0, Math.min(1, (height - priorHeight) / Math.max(1e-9, nextHeight - priorHeight)));
    return priorRadius + (nextRadius - priorRadius) * fraction;
  }
  return Number(profile.at(-1)[0]);
}
