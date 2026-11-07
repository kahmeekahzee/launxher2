(() => {
  "use strict";

  const API_BASE = (document.querySelector('meta[name="api-base"]')?.content || "").replace(/\/$/, "");
  const REFRESH_MS = 60_000;

  const MOOD_EMOJI = { chill: "😎", busy: "😬", crowded: "🥵", mystery: "🤷" };

  // Verdict lines per status combo, keyed "TUAS|WOODLANDS". Each is [line1, line2].
  const VERDICTS = {
    "CLEAR|CLEAR": [
      ["Both crossings clear.", "Go now, before everyone else reads this."],
      ["Tuas: smooth like butter.", "Woodlands: also butter. Rare day."],
      ["Green everywhere.", "Your laksa is waiting."],
    ],
    "CLEAR|SLOW": [
      ["Tuas: smooth like butter.", "Woodlands: bring kopi."],
      ["Tuas is the move.", "Woodlands is thinking about it."],
      ["Tuas: wide open.", "Woodlands: a little sticky."],
    ],
    "CLEAR|JAM": [
      ["Tuas: smooth like butter.", "Woodlands: bring a pillow."],
      ["Go Tuas. Trust us.", "Woodlands has become a car park."],
      ["Tuas: zoom zoom.", "Woodlands: see you next week."],
    ],
    "SLOW|CLEAR": [
      ["Woodlands: breezy for once.", "Tuas: a little sluggish."],
      ["Woodlands wins today.", "Tuas: bring kopi."],
      ["Woodlands: go go go.", "Tuas: taking its time."],
    ],
    "SLOW|SLOW": [
      ["Both a bit slow.", "Pick your favourite podcast."],
      ["Tuas: meh.", "Woodlands: also meh."],
      ["Everyone had the same idea.", "Bring kopi either way."],
    ],
    "SLOW|JAM": [
      ["Tuas: slow but moving.", "Woodlands: not moving."],
      ["Tuas is the lesser evil.", "Woodlands: pack snacks."],
      ["Tuas: bring kopi.", "Woodlands: bring dinner."],
    ],
    "JAM|CLEAR": [
      ["Woodlands: smooth like butter.", "Tuas: bring a pillow."],
      ["Go Woodlands. Seriously.", "Tuas is a parking lot."],
      ["Woodlands: wide open.", "Tuas: thoughts and prayers."],
    ],
    "JAM|SLOW": [
      ["Woodlands: slow but moving.", "Tuas: not moving."],
      ["Woodlands is the lesser evil.", "Tuas: pack snacks."],
      ["Woodlands: bring kopi.", "Tuas: bring dinner."],
    ],
    "JAM|JAM": [
      ["Both jammed.", "Maybe JB will still be there tomorrow."],
      ["Tuas: nope.", "Woodlands: also nope."],
      ["Everything is red.", "Have you considered staying home?"],
    ],
    UNKNOWN: [
      ["Traffic data is napping.", "Peek at the cams below."],
      ["Our crystal ball is cloudy.", "The cameras don't lie, though."],
    ],
  };

  const $ = (sel) => document.querySelector(sel);
  let lastData = null;
  let lastOkAt = 0;
  let lastVerdict = readLastVerdict();

  // --- data ---------------------------------------------------------------

  async function load() {
    try {
      const res = await fetch(`${API_BASE}/api/summary`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      lastData = data;
      lastOkAt = Date.now();
      render(data);
    } catch (e) {
      if (!lastData) {
        $("#verdict").innerHTML = lines(["Can't reach the traffic gods.", "Retrying in a minute."]);
      }
    }
    tick();
  }

  // --- render -------------------------------------------------------------

  function render(data) {
    const byId = Object.fromEntries(data.crossings.map((c) => [c.id, c]));
    $("#verdict").innerHTML = lines(pickVerdict(byId.tuas?.status, byId.woodlands?.status));
    $("#crossings").innerHTML = data.crossings.map(crossingHtml).join("");
    $("#attrib").hidden = !data.crossings.some((c) => Object.values(c.directions).some((d) => d.source === "tomtom"));
  }

  function crossingHtml(c) {
    const rows = ["to_jb", "to_sg"].map((k) => rowHtml(c.directions[k])).join("");
    return `
      <section class="card crossing" aria-label="${esc(c.name)}">
        <div class="crossing-head">
          <h2 class="crossing-name">${esc(c.name)}</h2>
          <span class="mood"><span class="mood-emoji" aria-hidden="true">${MOOD_EMOJI[c.mood] || "🤷"}</span>${esc(c.mood)}</span>
        </div>
        ${rows}
      </section>
      ${camsHtml(c)}`;
  }

  function rowHtml(d) {
    const eta = d.etaMinutes == null ? "–" : d.etaMinutes;
    const chip = d.status === "UNKNOWN" ? "N/A" : d.status;
    return `
      <div class="row">
        <div>
          <div class="dir-label">${esc(d.label)}</div>
          <div class="dir-sub">${esc(d.subtitle)}</div>
        </div>
        <div class="eta"><span class="eta-num">${eta}</span><span class="eta-unit">min est.</span></div>
        <span class="chip ${esc(d.status)}">${chip}</span>
      </div>`;
  }

  function camsHtml(c) {
    if (!c.cameras?.length) return `<div class="cams-empty">Cameras unavailable right now.</div>`;
    // To JB cams first, then To SG.
    const cams = [...c.cameras].sort((a, b) => (a.direction > b.direction ? 1 : -1));
    return `<div class="cams">${cams.map((cam) => `
      <button class="cam" type="button"
        data-src="${esc(cam.imageUrl)}" data-cap="${esc(cam.name)} · ${esc(timeOf(cam.timestamp))}">
        <img src="${esc(cam.imageUrl)}" alt="${esc(cam.name)}" loading="lazy" referrerpolicy="no-referrer">
        <span class="cam-tag"><span class="dot"></span>LIVE · ${cam.direction === "to_jb" ? "TO JB" : "TO SG"}</span>
      </button>`).join("")}</div>`;
  }

  function lines([a, b]) {
    return `<p class="verdict-line">${esc(a)}</p><p class="verdict-line">${esc(b)}</p>`;
  }

  // Random line for the status combo, never the same as the previous one.
  function pickVerdict(tuas, woodlands) {
    const key = `${tuas}|${woodlands}`;
    const pool = VERDICTS[key] || VERDICTS.UNKNOWN;
    const options = pool.filter((l) => l.join("/") !== lastVerdict);
    const choice = (options.length ? options : pool)[Math.floor(Math.random() * (options.length || pool.length))];
    lastVerdict = choice.join("/");
    try { localStorage.setItem("cw:lastVerdict", lastVerdict); } catch {}
    return choice;
  }

  function readLastVerdict() {
    try { return localStorage.getItem("cw:lastVerdict") || ""; } catch { return ""; }
  }

  // --- "Updated Xs ago" -----------------------------------------------------

  function tick() {
    const el = $("#updated");
    if (!lastData) { el.textContent = lastOkAt ? "" : "Offline · retrying"; return; }
    const at = Date.parse(lastData.generatedAt) || lastOkAt;
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    el.textContent = `Updated ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`} ago`;
    el.classList.toggle("stale", s > 180);
  }

  // --- lightbox -------------------------------------------------------------

  const box = $("#lightbox");
  document.addEventListener("click", (e) => {
    const cam = e.target.closest(".cam");
    if (cam) {
      $("#lightbox-img").src = cam.dataset.src;
      $("#lightbox-img").alt = cam.dataset.cap;
      $("#lightbox-cap").textContent = cam.dataset.cap;
      box.showModal();
    } else if (e.target === box) {
      box.close(); // tap on backdrop
    }
  });

  // --- helpers ------------------------------------------------------------------

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function timeOf(ts) {
    const d = new Date(ts);
    return isNaN(d) ? "" : d.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" });
  }

  // --- go ---------------------------------------------------------------

  load();
  setInterval(load, REFRESH_MS);
  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastOkAt > REFRESH_MS) load();
  });
})();
