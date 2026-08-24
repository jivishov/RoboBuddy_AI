export function openArmWorkcellLayout({ collisionProxies }) {
  const proxies = (collisionProxies || []).filter((item) => item?.type === "box" && Array.isArray(item.centerMm) && Array.isArray(item.halfExtentsMm));
  const worktops = proxies.filter((item) => String(item.id || "").endsWith("worktop"));
  const legs = proxies.filter((item) => String(item.id || "").includes("leg"));
  const worktopTopY = worktops.length
    ? Math.max(...worktops.map((item) => Number(item.centerMm[1]) + Number(item.halfExtentsMm[1])))
    : NaN;
  return {
    valid: worktops.length === 2 && legs.length === 8 && Number.isFinite(worktopTopY),
    worktops,
    legs,
    worktopTopY
  };
}
