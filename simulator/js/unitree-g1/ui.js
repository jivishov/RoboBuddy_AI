import { G1_INSTRUCTIONS } from "./instructions.js?v=20260812-g1-registration-fix-2";

export function ensureG1Styles() {
  if (typeof document === "undefined" || document.querySelector('link[data-unitree-g1-styles]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./styles.css", import.meta.url).href;
  link.dataset.unitreeG1Styles = "";
  document.head.appendChild(link);
}

export function g1StatusText(actionId, progress) {
  if (!actionId) return G1_INSTRUCTIONS.summary;
  return `${String(actionId).replace(/_/g, " ")} - ${Math.round((Number(progress) || 0) * 100)}%`;
}
