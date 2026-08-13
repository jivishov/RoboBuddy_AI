(function () {
  "use strict";

  const HINT_HOST_SELECTOR = "[data-button-hint-host][data-hint]:not([data-hint=''])";
  const HINT_TARGET_SELECTOR = "button[data-hint]:not([data-hint='']), a[data-hint]:not([data-hint=''])";
  const MIN_TOOLTIP_WIDTH = 768;
  const GAP = 12;
  const EDGE_GUTTER = 8;

  let tooltip = null;
  let activeTarget = null;
  let hideTimer = 0;

  function getTooltip() {
    if (tooltip) {
      return tooltip;
    }

    tooltip = document.createElement("div");
    tooltip.className = "button-hint-popover";
    tooltip.id = "buttonHintPopover";
    tooltip.setAttribute("role", "tooltip");
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function canShowTooltip() {
    return window.innerWidth >= MIN_TOOLTIP_WIDTH;
  }

  function hintText(target) {
    return (target.getAttribute("data-hint") || target.getAttribute("title") || "").trim();
  }

  function positionTooltip(target) {
    if (!tooltip || tooltip.hidden) {
      return;
    }

    const targetRect = target.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const targetCenter = targetRect.left + targetRect.width / 2;

    let placement = "top";
    let top = targetRect.top - tooltipRect.height - GAP;
    if (top < EDGE_GUTTER) {
      placement = "bottom";
      top = targetRect.bottom + GAP;
    }
    if (top + tooltipRect.height > viewportHeight - EDGE_GUTTER) {
      top = Math.max(EDGE_GUTTER, viewportHeight - tooltipRect.height - EDGE_GUTTER);
    }

    const halfWidth = tooltipRect.width / 2;
    const center = Math.min(
      Math.max(targetCenter, halfWidth + EDGE_GUTTER),
      viewportWidth - halfWidth - EDGE_GUTTER
    );
    const arrowX = Math.min(
      Math.max(targetCenter - (center - halfWidth), 14),
      tooltipRect.width - 14
    );

    tooltip.dataset.placement = placement;
    tooltip.style.left = `${center}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.setProperty("--hint-arrow-x", `${arrowX}px`);
  }

  function showTooltip(target) {
    if (!canShowTooltip()) {
      return;
    }

    const text = hintText(target);
    if (!text) {
      return;
    }

    window.clearTimeout(hideTimer);
    activeTarget = target;
    const currentTooltip = getTooltip();
    currentTooltip.textContent = text;
    currentTooltip.hidden = false;
    currentTooltip.classList.remove("is-visible");
    target.setAttribute("aria-describedby", currentTooltip.id);

    window.requestAnimationFrame(() => {
      if (activeTarget !== target) {
        return;
      }
      positionTooltip(target);
      currentTooltip.classList.add("is-visible");
    });
  }

  function hideTooltip(target) {
    if (!tooltip) {
      return;
    }

    const describedTarget = target || activeTarget;
    if (describedTarget) {
      describedTarget.removeAttribute("aria-describedby");
    }
    activeTarget = null;
    tooltip.classList.remove("is-visible");
    hideTimer = window.setTimeout(() => {
      if (!activeTarget && tooltip) {
        tooltip.hidden = true;
      }
    }, 140);
  }

  function findHintTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    return target.closest(HINT_HOST_SELECTOR) || target.closest(HINT_TARGET_SELECTOR);
  }

  document.addEventListener("pointerover", (event) => {
    const target = findHintTarget(event.target);
    if (target) {
      showTooltip(target);
    }
  }, true);

  document.addEventListener("pointerout", (event) => {
    const target = findHintTarget(event.target);
    if (target && !target.contains(event.relatedTarget)) {
      hideTooltip(target);
    }
  }, true);

  document.addEventListener("pointerdown", (event) => {
    const target = findHintTarget(event.target);
    if (target) {
      hideTooltip(target);
    }
  }, true);

  document.addEventListener("click", (event) => {
    const target = findHintTarget(event.target);
    if (target) {
      hideTooltip(target);
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    const key = event.key || "";
    if (key !== "Enter" && key !== " ") {
      return;
    }
    const target = findHintTarget(event.target);
    if (target) {
      hideTooltip(target);
    }
  }, true);

  document.addEventListener("focusin", (event) => {
    const target = findHintTarget(event.target);
    if (target) {
      showTooltip(target);
    }
  });

  document.addEventListener("focusout", (event) => {
    const target = findHintTarget(event.target);
    if (target) {
      hideTooltip(target);
    }
  });

  window.addEventListener("scroll", () => {
    if (activeTarget) {
      positionTooltip(activeTarget);
    }
  }, true);

  window.addEventListener("resize", () => {
    if (!activeTarget) {
      return;
    }
    if (!canShowTooltip()) {
      hideTooltip(activeTarget);
      return;
    }
    positionTooltip(activeTarget);
  });

  window.addEventListener("blur", () => {
    hideTooltip(activeTarget);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hideTooltip(activeTarget);
    }
  });
}());
