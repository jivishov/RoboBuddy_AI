(function initDocsNavigation() {
  "use strict";

  const TABLET_QUERY = "(min-width: 768px) and (max-width: 899px)";
  const COPY_RESET_MS = 2000;

  function enhanceCodeBlocks() {
    document.querySelectorAll(".python-docs__code").forEach((codeBlock) => {
      if (codeBlock.dataset.copyEnhanced === "true") return;
      const code = codeBlock.querySelector("code");
      if (!code) return;

      let host = codeBlock.parentElement;
      if (!host || !host.classList.contains("python-docs__code-frame")) {
        host = document.createElement("div");
        host.className = "python-docs__code-shell";
        codeBlock.parentNode.insertBefore(host, codeBlock);
        host.appendChild(codeBlock);
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "python-docs__copy";
      button.setAttribute("aria-label", "Copy code");
      button.title = "Copy code";
      button.innerHTML = '<i data-lucide="copy" aria-hidden="true"></i>';
      host.appendChild(button);
      codeBlock.dataset.copyEnhanced = "true";

      let resetTimer = null;
      const setButtonState = (state, label, icon) => {
        button.dataset.copyState = state;
        button.setAttribute("aria-label", label);
        button.title = label;
        button.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i>`;
        if (window.lucide) window.lucide.createIcons({ nodes: [button] });
      };

      button.addEventListener("click", async () => {
        window.clearTimeout(resetTimer);
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
            throw new Error("Clipboard API unavailable");
          }
          await navigator.clipboard.writeText(code.textContent);
          setButtonState("copied", "Code copied", "check");
        } catch (error) {
          setButtonState("error", "Copy failed", "triangle-alert");
        }
        resetTimer = window.setTimeout(() => setButtonState("idle", "Copy code", "copy"), COPY_RESET_MS);
      });
    });
  }

  function ready() {
    const disclosure = document.querySelector("[data-docs-nav-disclosure]");
    const nav = document.querySelector(".python-docs__nav");
    const navMore = document.querySelector("[data-docs-nav-more]");
    const links = nav ? Array.from(nav.querySelectorAll('a[href^="#"]')) : [];
    const sections = links
      .map((link) => document.getElementById(link.hash.slice(1)))
      .filter(Boolean);
    const currentLabels = Array.from(document.querySelectorAll("[data-docs-nav-current], [data-docs-header-current]"));
    const tabletMedia = window.matchMedia(TABLET_QUERY);
    let disclosureMode = "";

    enhanceCodeBlocks();
    document.querySelectorAll(".python-docs__code, .python-docs__table-wrap").forEach((scrollRegion) => {
      scrollRegion.tabIndex = 0;
    });

    function labelFor(link) {
      return String(link.textContent || "").replace(/\s+/g, " ").trim();
    }

    function updateNavMore() {
      if (!nav || !navMore || tabletMedia.matches) {
        if (navMore) {
          navMore.hidden = true;
        }
        return;
      }
      navMore.hidden = nav.scrollTop + nav.clientHeight >= nav.scrollHeight - 2;
    }

    function setActiveSection(sectionId) {
      let activeLink = null;
      links.forEach((link) => {
        const active = link.hash === `#${sectionId}`;
        if (active) {
          link.setAttribute("aria-current", "location");
          activeLink = link;
        } else {
          link.removeAttribute("aria-current");
        }
      });
      if (!activeLink) {
        return;
      }
      const label = labelFor(activeLink);
      currentLabels.forEach((node) => {
        node.textContent = label;
      });
      if (!tabletMedia.matches && nav) {
        const navBounds = nav.getBoundingClientRect();
        const linkBounds = activeLink.getBoundingClientRect();
        const visibleBottom = navBounds.bottom - (navMore && !navMore.hidden ? navMore.offsetHeight : 0);
        if (linkBounds.top < navBounds.top) {
          nav.scrollTop -= navBounds.top - linkBounds.top;
        } else if (linkBounds.bottom > visibleBottom) {
          nav.scrollTop += linkBounds.bottom - visibleBottom;
        }
        updateNavMore();
      }
    }

    function activeSectionAtReadingLine() {
      const readingLine = Math.max(96, window.innerHeight * 0.2);
      let active = sections[0] || null;
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= readingLine) {
          active = section;
        } else {
          break;
        }
      }
      if (active) {
        setActiveSection(active.id);
      }
    }

    function syncDisclosure() {
      if (!disclosure) {
        return;
      }
      const nextMode = tabletMedia.matches ? "tablet" : "desktop";
      if (nextMode === disclosureMode) {
        return;
      }
      disclosureMode = nextMode;
      disclosure.open = nextMode === "desktop";
      updateNavMore();
    }

    links.forEach((link) => {
      link.addEventListener("click", () => setActiveSection(link.hash.slice(1)));
    });

    if (nav && navMore) {
      nav.addEventListener("scroll", updateNavMore, { passive: true });
      navMore.addEventListener("click", () => {
        nav.scrollBy({
          top: Math.max(120, nav.clientHeight * 0.6),
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
        });
      });
      window.addEventListener("resize", updateNavMore);
      window.addEventListener("load", updateNavMore, { once: true });
    }

    if ("IntersectionObserver" in window && sections.length) {
      const observer = new IntersectionObserver(activeSectionAtReadingLine, {
        root: null,
        rootMargin: "-10% 0px -70% 0px",
        threshold: [0, 0.01, 0.25, 0.5]
      });
      sections.forEach((section) => observer.observe(section));
    }

    window.addEventListener("hashchange", () => {
      const sectionId = window.location.hash.slice(1);
      if (sectionId) {
        setActiveSection(sectionId);
      }
    });

    tabletMedia.addEventListener("change", syncDisclosure);
    syncDisclosure();
    setActiveSection(window.location.hash.slice(1) || "quick-start");
    updateNavMore();

    if (window.lucide) {
      window.lucide.createIcons();
    }
    document.documentElement.dataset.docsNavigationReady = "true";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready, { once: true });
  } else {
    ready();
  }
})();
