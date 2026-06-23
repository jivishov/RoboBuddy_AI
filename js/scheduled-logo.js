(() => {
  const LOGO_SCHEDULE = [
    {
      startMinute: (8 * 60) + 30,
      endMinute: 13 * 60,
      src: "assets/logos/robo-buddy-cougar-middle.png"
    },
    {
      startMinute: 13 * 60,
      endMinute: 17 * 60,
      src: "assets/logos/robo-buddy-cougar-high.png"
    }
  ];

  function centralMinuteOfDay(date) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });
    const parts = formatter.formatToParts(date);
    const hour = Number((parts.find((part) => part.type === "hour") || {}).value);
    const minute = Number((parts.find((part) => part.type === "minute") || {}).value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return -1;
    }
    return (hour * 60) + minute;
  }

  function resolveLogoSrc(date) {
    const minuteOfDay = centralMinuteOfDay(date);
    const match = LOGO_SCHEDULE.find((entry) => (
      minuteOfDay >= entry.startMinute && minuteOfDay < entry.endMinute
    ));
    return match ? match.src : "";
  }

  function applyScheduledLogo() {
    const logoSrc = resolveLogoSrc(new Date());
    document.querySelectorAll("[data-scheduled-logo]").forEach((logo) => {
      const image = logo.querySelector("[data-scheduled-logo-img]");
      if (!logoSrc || !image) {
        logo.hidden = true;
        if (image) {
          image.removeAttribute("src");
        }
        return;
      }
      image.src = logoSrc;
      logo.hidden = false;
    });
  }

  document.addEventListener("DOMContentLoaded", applyScheduledLogo);
})();
