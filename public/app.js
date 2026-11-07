(() => {
  "use strict";

  const API_BASE = (document.querySelector('meta[name="api-base"]')?.content || "").replace(/\/$/, "");
  const REFRESH_MS = 3 * 60_000;
  // The Worker writes new data every 10 min, and at least every 20 min even if
  // nothing changed; older than this means updates have stalled.
  const STALE_MIN = 35;

  const MOOD_EMOJI = { chill: "😎", busy: "😬", crowded: "🥵", mystery: "🤷" };
  const DIR_LABEL = { to_jb: "To JB", to_sg: "To SG" };

  const $ = (sel) => document.querySelector(sel);
  let lastData = null;
  let lastOkAt = 0;
  let loading = false;
  const camIndex = {}; // carousel position per crossing, kept across refreshes

  // --- data ---------------------------------------------------------------

  async function load() {
    if (loading) return;
    loading = true;
    setRefreshing(true);
    try {
      const res = await fetch(`${API_BASE}/api/summary`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      lastData = data;
      lastOkAt = Date.now();
      render(data);
    } catch (e) {
      if (!lastData) $("#verdict").innerHTML = lines(["Can't reach the traffic gods.", "Tap Refresh to try again."]);
    } finally {
      loading = false;
      setRefreshing(false);
      tick();
    }
  }

  function setRefreshing(on) {
    const btn = $("#refresh");
    btn.disabled = on;
    btn.classList.toggle("spinning", on);
  }

  // --- render -------------------------------------------------------------

  function render(data) {
    const v = data.verdict;
    $("#verdict").innerHTML = v
      ? ["to_jb", "to_sg"].map((d) => verdictLine(v[d] && v[d].text)).join("")
      : lines(["Checking the roads…", ""]);
    $("#crossings").innerHTML = data.crossings.map(crossingHtml).join("");
    $("#attrib").hidden = !data.crossings.some((c) => Object.values(c.directions).some((d) => d.source === "tomtom"));
    renderHow(data.thresholds);
    for (const c of data.crossings) restoreCarousel(c.id);
  }

  // "To JB: Tuas ~65 min faster. Woodlands: pack snacks." → bold direction label.
  function verdictLine(text) {
    if (!text) return `<p class="verdict-line">&nbsp;</p>`;
    const i = text.indexOf(": ");
    return i > 0
      ? `<p class="verdict-line"><span class="verdict-dir">${esc(text.slice(0, i))}</span> ${esc(text.slice(i + 2))}</p>`
      : `<p class="verdict-line">${esc(text)}</p>`;
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
        ${camsHtml(c)}
      </section>`;
  }

  function rowHtml(d) {
    const range = d.etaLow != null && d.etaHigh != null && d.etaHigh > d.etaLow;
    const eta = d.etaMinutes == null ? "–" : range ? `${d.etaLow}–${d.etaHigh}` : d.etaMinutes;
    const chip = d.status === "UNKNOWN" ? "N/A" : d.status;
    return `
      <div class="row">
        <div>
          <div class="dir-label">${esc(d.label)}</div>
          <div class="dir-sub">${esc(d.subtitle)}</div>
        </div>
        <div class="eta"><span class="eta-num${range ? " range" : ""}">${eta}</span><span class="eta-unit">min est.</span></div>
        <span class="chip ${esc(d.status)}">${chip}</span>
      </div>`;
  }

  // One camera per slide, full card width; swipe or tap the dots.
  function camsHtml(c) {
    if (!c.cameras?.length) return `<div class="cams-empty">Cameras unavailable right now.</div>`;
    const cams = [...c.cameras].sort((a, b) => (a.direction === b.direction ? 0 : a.direction < b.direction ? -1 : 1)); // To JB first, else Worker order
    const slides = cams.map((cam) => {
      const dir = DIR_LABEL[cam.direction] || "";
      const time = timeOf(cam.timestamp);
      return `
        <figure class="cam-slide">
          <button class="cam" type="button" data-src="${esc(cam.imageUrl)}" data-cap="${esc(cam.name)} · ${esc(dir)} · ${esc(time)}">
            <img src="${esc(cam.imageUrl)}" alt="${esc(cam.name)}, ${esc(dir)}" loading="lazy" referrerpolicy="no-referrer">
            <span class="cam-tag"><span class="dot"></span>LIVE · ${esc(dir.toUpperCase())}</span>
          </button>
          <figcaption><span class="cam-name">${esc(cam.name)}</span><span class="cam-meta">${esc(dir)} · ${esc(time)}</span></figcaption>
        </figure>`;
    }).join("");
    const dots = cams.length > 1
      ? `<div class="cam-dots" role="tablist">${cams.map((cam, i) =>
          `<button type="button" class="cam-dot" data-crossing="${esc(c.id)}" data-i="${i}" aria-label="Camera ${i + 1} of ${cams.length}"></button>`).join("")}</div>`
      : "";
    return `<div class="cams" data-crossing="${esc(c.id)}" aria-label="Live cameras">${slides}</div>${dots}`;
  }

  function carousel(id) {
    return document.querySelector(`.cams[data-crossing="${id}"]`);
  }

  function markDot(id, i) {
    document.querySelectorAll(`.cam-dot[data-crossing="${id}"]`).forEach((d, j) => d.setAttribute("aria-current", j === i ? "true" : "false"));
  }

  function restoreCarousel(id) {
    const el = carousel(id);
    if (!el) return;
    const i = Math.min(camIndex[id] || 0, el.children.length - 1);
    el.scrollLeft = i * el.clientWidth;
    markDot(id, i);
    el.addEventListener("scroll", () => {
      const j = Math.round(el.scrollLeft / el.clientWidth);
      if (j !== camIndex[id]) { camIndex[id] = j; markDot(id, j); }
    }, { passive: true });
  }

  function lines([a, b]) {
    return `<p class="verdict-line">${esc(a)}</p><p class="verdict-line">${esc(b) || "&nbsp;"}</p>`;
  }

  // --- "How to read this", from the Worker's own thresholds ----------------

  function renderHow(t) {
    if (!t) return;
    const d = t.delayMin, q = t.queueLevel, r = t.ltaRatio;
    $("#how-body").innerHTML = `
      <p><b>A range like 126–186 min</b> is the estimated time from the expressway on one side to past the far checkpoint. The low end assumes the checkpoint queue moves well, the high end that it crawls. It is the live drive time (TomTom) plus a queue allowance read from the checkpoint cameras, each read about every ${t.queueEveryMin} min.</p>
      <p><b>A single number</b> means there was no fresh camera reading, so a flat 10 min is added for immigration.</p>
      <table class="how-table">
        <tr><td><span class="chip CLEAR">CLEAR</span></td><td>Traffic delay under ${d.slow} min, and a light queue on the cameras.</td></tr>
        <tr><td><span class="chip SLOW">SLOW</span></td><td>Delay of ${d.slow}–${d.jam - 1} min, or a dense queue on a camera.</td></tr>
        <tr><td><span class="chip JAM">JAM</span></td><td>Delay of ${d.jam}+ min, or a packed queue on <em>both</em> cameras for that direction.</td></tr>
      </table>
      <p class="how-small">Delay is the live drive time minus the same drive with no traffic. Cameras rate the queue 0 (free-flowing) to 4 (standstill); ${q.slow} counts as dense and ${q.jam}+ as packed. If live drive times are unavailable, LTA expressway times are used instead: SLOW from ${r.slow}× the normal time, JAM from ${r.jam}×.</p>`;
  }

  // --- current date and time (Singapore), e.g. "Sat 7 Nov · 6:24 pm" --------

  const SG = "Asia/Singapore";
  const fmtDate = new Intl.DateTimeFormat("en-SG", { weekday: "short", day: "numeric", month: "short", timeZone: SG });
  const fmtTime = new Intl.DateTimeFormat("en-SG", { hour: "numeric", minute: "2-digit", timeZone: SG });
  const fmtIso = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: SG });

  function clock() {
    const d = new Date();
    const p = Object.fromEntries(fmtDate.formatToParts(d).map((x) => [x.type, x.value]));
    const text = `${p.weekday} ${p.day} ${p.month} · ${fmtTime.format(d)}`;
    const el = $("#now");
    if (el.textContent !== text) {
      el.textContent = text;
      // e.g. "2026-11-07 18:24" in Singapore time, for screen readers and tools.
      el.dateTime = fmtIso.format(d).replace(", ", "T") + "+08:00";
    }
  }

  // --- "Updated Xm ago" = age of the data, not of the page load ----------------

  function tick() {
    const el = $("#updated");
    if (!lastData) { el.textContent = lastOkAt || loading ? "Loading…" : "Offline"; return; }
    const at = Date.parse(lastData.dataAt);
    if (!at) { el.textContent = ""; return; }
    const m = Math.max(0, Math.floor((Date.now() - at) / 60000));
    el.textContent = `Updated ${m < 1 ? "just now" : `${m}m ago`}`;
    el.title = `Data from ${timeOf(lastData.dataAt)}`;
    el.classList.toggle("stale", m > STALE_MIN);
  }

  // --- clicks: lightbox, carousel dots, refresh -------------------------------

  const box = $("#lightbox");
  document.addEventListener("click", (e) => {
    const dot = e.target.closest(".cam-dot");
    if (dot) {
      const el = carousel(dot.dataset.crossing);
      el.scrollTo({ left: Number(dot.dataset.i) * el.clientWidth, behavior: "smooth" });
      return;
    }
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
  $("#refresh").addEventListener("click", load);

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
  setInterval(tick, 15_000);
  clock();
  setInterval(clock, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastOkAt > REFRESH_MS) load();
  });
})();
