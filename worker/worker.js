// JamOrNot API: a single Cloudflare Worker.
//
// How data flows (so every visitor sees the same numbers):
//   - A cron run every 10 min (wrangler.toml [triggers]) fetches TomTom, LTA and
//     one camera queue reading, computes the whole result (ETAs, statuses,
//     verdict) and writes ONE record to KV, skipping the write if nothing changed.
//   - Page loads only READ that record. They never call TomTom or the AI model.
//   - Every value carries the time it was fetched ("at"); the record carries
//     "updatedAt" (when it was last written), shown on the page as "Updated".
//
// Endpoints: GET /api/summary   what the page shows (record + live camera thumbnails)
//            GET /api/state     the raw stored record (routes, LTA, queue readings)
//            GET /api/cameras   live camera list (thumbnails)
//            GET /api/routes, /api/travel-times, /api/queue   views of /api/state

// ---------------------------------------------------------------------------
// CONFIG: edit these freely
// ---------------------------------------------------------------------------

// Traffic cameras to keep. Add/remove IDs here.
// direction: "to_jb" | "to_sg"; crossing: key from ROUTES below.
const CAMERAS = [
  { id: "2701", crossing: "woodlands", direction: "to_jb", name: "Woodlands Causeway (towards JB)" },
  // 2702 shows both ways, but its busy side is the Causeway-bound queue.
  { id: "2702", crossing: "woodlands", direction: "to_jb", name: "Woodlands Checkpoint (Causeway-bound)" },
  { id: "2704", crossing: "woodlands", direction: "to_jb", name: "BKE to Woodlands Checkpoint" },
  { id: "4703", crossing: "tuas", direction: "to_jb", name: "Tuas Second Link (towards JB)" },
  { id: "4712", crossing: "tuas", direction: "to_jb", name: "AYE Tuas Ave 8 exit" },
  { id: "4713", crossing: "tuas", direction: "to_sg", name: "Tuas Checkpoint" },
];

// Expressways whose segments we keep from LTA Estimated Travel Times.
const EXPRESSWAYS = ["BKE", "AYE"];

// LTA fallback, per crossing and direction: which expressway segments to sum,
// and the off-peak baselines used to turn "segment minutes now" into an ETA.
//   farEnd:          keep segments whose FarEndPoint contains any of these words
//   fallbackDir:     LTA Direction (1/2) used if no FarEndPoint matches
//   baselineSegMin:  off-peak sum of the matching segment times (minutes)
//   offPeakEtaMin:   off-peak time to get across, checkpoint included (minutes)
// ETA = offPeakEtaMin * (segment minutes now / baselineSegMin), never below offPeakEtaMin.
const ROUTES = {
  woodlands: {
    name: "Woodlands Causeway",
    short: "Woodlands",
    to_jb: { label: "To JB", subtitle: "BKE → Woodlands Checkpoint", expressway: "BKE", farEnd: ["WOODLANDS"], fallbackDir: 1, baselineSegMin: 8, offPeakEtaMin: 20 },
    to_sg: { label: "To SG", subtitle: "Woodlands Checkpoint → BKE", expressway: "BKE", farEnd: ["PIE"], fallbackDir: 2, baselineSegMin: 8, offPeakEtaMin: 25 },
  },
  tuas: {
    name: "Tuas Second Link",
    short: "Tuas",
    to_jb: { label: "To JB", subtitle: "AYE → Tuas Checkpoint", expressway: "AYE", farEnd: ["TUAS"], fallbackDir: 1, baselineSegMin: 20, offPeakEtaMin: 15 },
    to_sg: { label: "To SG", subtitle: "Tuas Checkpoint → AYE", expressway: "AYE", farEnd: ["CITY", "MCE", "MARINA", "SHENTON", "KEPPEL"], fallbackDir: 2, baselineSegMin: 20, offPeakEtaMin: 18 },
  },
};

// LTA fallback status thresholds on the ratio (segment minutes now / off-peak baseline).
const THRESHOLDS = { slow: 1.3, jam: 1.8 };
const MOODS = { CLEAR: "chill", SLOW: "busy", JAM: "crowded", UNKNOWN: "mystery" };

// TomTom live-traffic routes across each crossing (used when TOMTOM_KEY is set;
// LTA estimate above is the fallback). Points are "lat,lon".
// Check a route by pasting from/to into Google Maps; /api/routes shows routeKm.
//   checkpointMin: time inside immigration, used only when there is no camera reading
const TOMTOM_ROUTES = {
  woodlands: {
    // Checked against OSM routing: ~9 km each, via BKE ⇄ Causeway ⇄ JB CIQ.
    to_jb: { from: "1.41275,103.77133", to: "1.4630,103.7640", via: "BKE → Causeway → JB CIQ", checkpointMin: 10 },
    to_sg: { from: "1.4800,103.7620", to: "1.4128,103.7722", via: "JB CIQ → Causeway → BKE", checkpointMin: 10 },
  },
  tuas: {
    // Points must sit on the right carriageway or the route U-turns. ~10 km each,
    // via AYE ⇄ Second Link ⇄ Sultan Abu Bakar CIQ (Tanjung Kupang) ⇄ E3.
    to_jb: { from: "1.3260,103.6602", to: "1.38644,103.59258", via: "AYE → Second Link → Tanjung Kupang CIQ", checkpointMin: 10 },
    to_sg: { from: "1.39125,103.59018", to: "1.33103,103.6551", via: "Tanjung Kupang CIQ → Second Link → AYE", checkpointMin: 10 },
  },
};
// Status from the traffic delay (TomTom live minus no-traffic time), in minutes.
const DELAY_THRESHOLDS_MIN = { slow: 10, jam: 30 };
// A stored TomTom route older than this is ignored and LTA is used instead.
const ROUTE_MAX_AGE_MIN = 30;

// Camera queue estimate (PROTOTYPE, Workers AI vision). TomTom misses the
// crawl at the checkpoints, so a vision model rates the queue each way on the
// cameras below, 0–4. Each direction has two cameras; a level of 3+ (JAM) only
// counts when BOTH agree, otherwise it is capped at 2. The level adds a
// [low, high] range of minutes to the drive time. Needs the AI binding.
//   hint: where each direction's lanes are in the frame, by fixed landmarks
const QUEUE_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const QUEUE_CAMERAS = {
  "2701": { crossing: "woodlands", hint: "The Causeway bridge runs diagonally from bottom-left to top-right and has two carriageways. The carriageway on the upper-left side, next to the open water, carries traffic heading to Johor (to_jb). The carriageway on the lower-right side, next to the large pipes, carries traffic heading into Singapore (to_sg)." },
  "2702": { crossing: "woodlands", hint: "Woodlands Checkpoint, looking from the checkpoint towards the BKE. to_sg is ONLY the leftmost road: it runs up the left edge of the image from the green 'BKE City' sign at the bottom-left. Everything to the right of that road (the centre lanes, the right-hand lanes and the long curved elevated ramp) is traffic towards the Causeway and Johor (to_jb). Ignore the distant roads near the top of the image." },
  "4712": { crossing: "tuas", hint: "The AYE expressway near Tuas. The wide carriageway in the left and centre of the image heads to Tuas Checkpoint and Johor (to_jb); its queue may fill only the leftmost lanes while the other lanes move, so rate the queue in its leftmost lanes. The carriageway on the far right, beyond the line of trees, heads into Singapore (to_sg)." },
  "4713": { crossing: "tuas", hint: "Tuas Checkpoint. There is a tall dark tree in the middle of the image. to_sg is the road to the LEFT of that tree, which curves off the left edge of the image. to_jb is the lanes to the RIGHT of that tree, running up towards the top-right and lined with red-and-white barriers. Ignore the distant roads at the very top." },
};
// Queue level → status. JAM needs both cameras to agree (see above).
const QUEUE_STATUS_LEVELS = { slow: 2, jam: 3 };
// Minutes of queue to add per level, as [low, high]. Level 4 calibrated against
// another app on Sat 7 Nov 17:06 (Woodlands to JB 124–184, Tuas 93–140).
const QUEUE_MINUTES = {
  woodlands: [[0, 5], [5, 15], [15, 40], [40, 90], [90, 150]],
  tuas: [[0, 5], [5, 15], [15, 35], [35, 70], [70, 120]],
};
// One camera is read per cron run, in this order, so each camera is read every
// 40 min (~1.5/hour, 144 reads/day ≈ 1,500–5,000 of the 10,000 free neurons).
// The two cameras of a direction are read 10 min apart.
const QUEUE_ROTATION = ["2701", "2702", "4712", "4713"];
// Readings older than this are ignored.
const QUEUE_MAX_AGE_MIN = 90;

// KV record. Writes are skipped when nothing but timestamps changed, except a
// heartbeat write at least this often so "Updated" and ages stay honest.
const STORE_KEY = "state-v1";
const HEARTBEAT_MIN = 20;

// How long one Cloudflare instance reuses what it read (seconds).
const TTL = { cameras: 60, state: 30, liveFallback: 180 };

const TRAFFIC_IMAGES_URL = "https://api.data.gov.sg/v1/transport/traffic-images";
const LTA_TRAVEL_TIMES_URL = "https://datamall2.mytransport.sg/ltaodataservice/EstTravelTimes";
const TOMTOM_ROUTING_URL = "https://api.tomtom.com/routing/1/calculateRoute";

// ---------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

    const { pathname } = new URL(request.url);
    try {
      switch (pathname) {
        case "/api/summary":
          return json(await getSummary(request, env, ctx), 200, 15);
        case "/api/cameras":
          return json(await getCameras(request, ctx), 200, TTL.cameras);
        case "/api/state":
          return json(await readRecord(env), 200, 15);
        case "/api/routes": {
          const r = await readRecord(env);
          return json({ updatedAt: r && r.updatedAt, routes: r ? r.state.routes : {} }, 200, 15);
        }
        case "/api/travel-times": {
          const r = await readRecord(env);
          return json(r ? r.state.travelTimes : null, 200, 15);
        }
        case "/api/queue": {
          const r = await readRecord(env);
          return json({ model: QUEUE_MODEL, readings: r ? r.state.queue : {} }, 200, 15);
        }
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 502);
    }
  },

  // Cron: the only place that calls TomTom, LTA and the AI model, and writes KV.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runUpdate(env, controller.scheduledTime).then(
      (r) => console.log("update", JSON.stringify(r)),
      (e) => console.error("update failed", e && e.stack || e),
    ));
  },
};

function json(data, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      ...CORS,
    },
  });
}

const errText = (e) => String(e && e.message || e).slice(0, 200);
const ageMin = (iso, now) => (iso ? (now - Date.parse(iso)) / 60000 : Infinity);

// Per-instance reuse of a value for a few seconds (not shared between instances,
// so it only ever holds copies of shared data or of the live camera list).
const memo = new Map();
async function memoize(key, ttlSec, produce) {
  const m = memo.get(key);
  if (m && m.expires > Date.now()) return m.data;
  const data = await produce();
  memo.set(key, { data, expires: Date.now() + ttlSec * 1000 });
  return data;
}

// --- upstream fetchers (used by the cron) ------------------------------------

async function fetchCameraList() {
  const res = await fetch(TRAFFIC_IMAGES_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`traffic-images upstream ${res.status}`);
  const body = await res.json();
  const all = (body.items && body.items[0] && body.items[0].cameras) || [];
  const byId = new Map(all.map((c) => [String(c.camera_id), c]));
  return CAMERAS.filter((c) => byId.has(c.id)).map((c) => ({
    id: c.id,
    name: c.name,
    crossing: c.crossing,
    direction: c.direction,
    imageUrl: byId.get(c.id).image,
    timestamp: byId.get(c.id).timestamp,
  }));
}

// Live camera thumbnails for the page (not stored: images change every minute).
function getCameras(request, ctx) {
  return memoize("cameras", TTL.cameras, async () => ({ updatedAt: new Date().toISOString(), cameras: await fetchCameraList() }));
}

async function fetchTravelTimes(env) {
  if (!env.LTA_ACCOUNT_KEY) throw new Error("LTA_ACCOUNT_KEY secret is not set");
  const rows = [];
  for (let skip = 0; skip < 2500; skip += 500) {
    const url = skip ? `${LTA_TRAVEL_TIMES_URL}?$skip=${skip}` : LTA_TRAVEL_TIMES_URL;
    const res = await fetch(url, { headers: { AccountKey: env.LTA_ACCOUNT_KEY, accept: "application/json" } });
    if (!res.ok) throw new Error(`LTA upstream ${res.status}`);
    const page = (await res.json()).value || [];
    rows.push(...page);
    if (page.length < 500) break;
  }
  return rows
    .filter((r) => EXPRESSWAYS.includes(String(r.Name).toUpperCase()))
    .map((r) => ({
      expressway: String(r.Name).toUpperCase(),
      direction: Number(r.Direction),
      farEnd: r.FarEndPoint,
      start: r.StartPoint,
      end: r.EndPoint,
      minutes: Number(r.EstTime),
    }));
}

async function fetchRoute(cfg, key) {
  const params = new URLSearchParams({
    key,
    traffic: "true",
    travelMode: "car",
    routeType: "fastest",
    computeTravelTimeFor: "all", // adds noTrafficTravelTimeInSeconds
  });
  const res = await fetch(`${TOMTOM_ROUTING_URL}/${cfg.from}:${cfg.to}/json?${params}`);
  if (!res.ok) throw new Error(`TomTom upstream ${res.status}`); // never echo the URL: it holds the key
  const s = (await res.json()).routes?.[0]?.summary;
  if (!s) throw new Error("TomTom returned no route");
  return {
    from: cfg.from,
    to: cfg.to,
    via: cfg.via,
    routeKm: Math.round(s.lengthInMeters / 100) / 10,
    driveMin: Math.round(s.travelTimeInSeconds / 60),
    freeFlowMin: Math.round((s.noTrafficTravelTimeInSeconds ?? s.travelTimeInSeconds) / 60),
    // Delay = live travel time minus no-traffic time. TomTom's own
    // trafficDelayInSeconds under-reports here (e.g. 1 min when drive is 31 vs 20).
    delayMin: Number.isFinite(s.noTrafficTravelTimeInSeconds)
      ? Math.max(0, Math.round((s.travelTimeInSeconds - s.noTrafficTravelTimeInSeconds) / 60))
      : Math.round((s.trafficDelayInSeconds || 0) / 60),
    tomtomDelayMin: Math.round((s.trafficDelayInSeconds || 0) / 60), // kept for comparison
  };
}

async function classifyCamera(env, cam, hint) {
  const img = await fetch(cam.imageUrl);
  if (!img.ok) throw new Error(`camera image ${img.status}`);
  // Preallocated loop: ~1 ms for a 220 KB image vs ~11 ms for [...bytes],
  // which would blow the Workers Free plan's 10 ms CPU limit on its own.
  const bytes = new Uint8Array(await img.arrayBuffer());
  const image = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) image[i] = bytes[i];
  const prompt =
    `This is a live traffic camera image in Singapore. ${hint} ` +
    "The two directions are often very different: judge each direction only from its own lanes. " +
    "Rate the vehicle queue in each direction: 0 = empty or free-flowing, 1 = busy but moving, " +
    "2 = dense and slow, 3 = packed, stop-and-go, 4 = bumper-to-bumper standstill filling the lanes. " +
    'Reply with only JSON, no other text: {"to_jb": <0-4>, "to_sg": <0-4>}';
  const input = { prompt, image, max_tokens: 60, temperature: 0 };

  let out;
  try {
    out = await env.AI.run(QUEUE_MODEL, input);
  } catch (err) {
    // First use: Meta's licence must be accepted once by sending "agree".
    if (!/agree|licen[cs]e/i.test(errText(err))) throw err;
    await env.AI.run(QUEUE_MODEL, { prompt: "agree" });
    out = await env.AI.run(QUEUE_MODEL, input);
  }

  // The binding auto-parses a JSON reply, so response may already be an object.
  const text = typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? "");
  const match = text.match(/\{[^{}]*\}/);
  if (!match) throw new Error(`no JSON in model reply: ${text.slice(0, 80)}`);
  const parsed = JSON.parse(match[0]);
  const level = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(4, Math.max(0, n)) : null;
  };
  const to_jb = level(parsed.to_jb), to_sg = level(parsed.to_sg);
  if (to_jb == null && to_sg == null) throw new Error(`unusable model reply: ${text.slice(0, 80)}`);
  return { to_jb, to_sg, imageTimestamp: cam.timestamp, raw: text.slice(0, 200) };
}

// --- cron: collect, compute, store ----------------------------------------

// Fetch everything that changed since `prev` and return the new raw state.
// A failed fetch keeps the previous value (with its old "at") and notes the error.
async function collect(env, prev, now, { readCameraId } = {}) {
  const at = new Date(now).toISOString();
  const state = {
    routes: structuredClone(prev.routes || {}),
    travelTimes: prev.travelTimes || null,
    queue: structuredClone(prev.queue || {}),
    errors: [],
  };

  const routeJobs = [];
  if (env.TOMTOM_KEY) {
    for (const [crossing, dirs] of Object.entries(TOMTOM_ROUTES)) {
      for (const [dir, cfg] of Object.entries(dirs)) {
        routeJobs.push(fetchRoute(cfg, env.TOMTOM_KEY).then(
          (r) => { (state.routes[crossing] ||= {})[dir] = { ...r, at }; },
          (e) => { state.errors.push(`route ${crossing}/${dir}: ${errText(e)}`); },
        ));
      }
    }
  } else {
    state.errors.push("TOMTOM_KEY secret is not set");
  }

  const [, lta, cams] = await Promise.allSettled([Promise.all(routeJobs), fetchTravelTimes(env), fetchCameraList()]);
  if (lta.status === "fulfilled") state.travelTimes = { segments: lta.value, at };
  else state.errors.push(`LTA: ${errText(lta.reason)}`);

  if (readCameraId) {
    const cam = cams.status === "fulfilled" && cams.value.find((c) => c.id === readCameraId);
    if (!env.AI) state.errors.push("AI binding not set: camera queue estimate off");
    else if (!cam) state.errors.push(`queue cam ${readCameraId}: camera not in feed`);
    else {
      try {
        state.queue[readCameraId] = { ...(await classifyCamera(env, cam, QUEUE_CAMERAS[readCameraId].hint)), at };
      } catch (e) {
        // Keep the last good levels (they age out after QUEUE_MAX_AGE_MIN).
        state.queue[readCameraId] = { ...(state.queue[readCameraId] || {}), error: errText(e), errorAt: at };
        state.errors.push(`queue cam ${readCameraId}: ${errText(e)}`);
      }
    }
  }
  return state;
}

async function runUpdate(env, scheduledTime = Date.now()) {
  if (!env.STORE) throw new Error("STORE KV binding is not set (see wrangler.toml)");
  const now = scheduledTime;
  const prev = (await env.STORE.get(STORE_KEY, { type: "json" })) || {};
  const run = Math.floor(now / 600000); // one slot per 10-min cron run
  const readCameraId = QUEUE_ROTATION[run % QUEUE_ROTATION.length];

  const state = await collect(env, prev.state || {}, now, { readCameraId });
  const view = computeView(state, now, prev.view);
  const next = { state, view };

  const changed = JSON.stringify(stripTimes(next)) !== JSON.stringify(stripTimes({ state: prev.state, view: prev.view }));
  const stale = ageMin(prev.updatedAt, now) >= HEARTBEAT_MIN;
  if (!changed && !stale) return { wrote: false, readCameraId, errors: state.errors };

  const updatedAt = new Date(now).toISOString();
  await env.STORE.put(STORE_KEY, JSON.stringify({ ...next, updatedAt }));
  return { wrote: true, changed, readCameraId, errors: state.errors };
}

// Drop timestamps (and the model's raw text) so "unchanged" means the numbers.
function stripTimes(v) {
  if (Array.isArray(v)) return v.map(stripTimes);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (/^(at|updatedAt|errorAt|imageTimestamp|raw|driveAt|queueAt|dataAt)$/.test(k)) continue;
      out[k] = stripTimes(v[k]);
    }
    return out;
  }
  return v;
}

// --- computing what the page shows ---------------------------------------

function computeView(state, now, prevView) {
  const crossings = Object.entries(ROUTES).map(([id, route]) => {
    const directions = {};
    for (const dir of ["to_jb", "to_sg"]) {
      const r = state.routes && state.routes[id] && state.routes[id][dir];
      const cfg = TOMTOM_ROUTES[id][dir];
      let d;
      if (r && r.driveMin != null && ageMin(r.at, now) <= ROUTE_MAX_AGE_MIN) {
        d = estimateTomTom({ label: route[dir].label, subtitle: cfg.via }, cfg, r);
      } else {
        d = estimate(route[dir], state.travelTimes);
      }
      directions[dir] = applyQueue(d, id, queueLevel(state.queue || {}, id, dir, now));
    }
    const status = worst(directions.to_jb.status, directions.to_sg.status);
    return { id, name: route.name, status, mood: MOODS[status], directions };
  });
  return {
    crossings,
    verdict: computeVerdict(crossings, prevView && prevView.verdict),
    thresholds: {
      delayMin: DELAY_THRESHOLDS_MIN,
      queueLevel: QUEUE_STATUS_LEVELS,
      queueMinutes: QUEUE_MINUTES,
      ltaRatio: THRESHOLDS,
      queueEveryMin: QUEUE_ROTATION.length * 10,
    },
    errors: state.errors || [],
  };
}

function estimateTomTom(base, cfg, r) {
  const status = r.delayMin >= DELAY_THRESHOLDS_MIN.jam ? "JAM" : r.delayMin >= DELAY_THRESHOLDS_MIN.slow ? "SLOW" : "CLEAR";
  return {
    ...base,
    etaMinutes: r.driveMin + cfg.checkpointMin,
    status,
    mood: MOODS[status],
    source: "tomtom",
    driveMin: r.driveMin,
    delayMin: r.delayMin,
    routeKm: r.routeKm,
    driveAt: r.at,
  };
}

function estimate(cfg, travelTimes) {
  const base = { label: cfg.label, subtitle: cfg.subtitle, etaMinutes: null, status: "UNKNOWN", mood: MOODS.UNKNOWN };
  const segments = travelTimes && travelTimes.segments;
  if (!segments) return base;

  const onRoad = segments.filter((s) => s.expressway === cfg.expressway);
  let picked = onRoad.filter((s) => cfg.farEnd.some((w) => String(s.farEnd || "").toUpperCase().includes(w)));
  if (!picked.length) picked = onRoad.filter((s) => s.direction === cfg.fallbackDir);
  if (!picked.length) return base;

  const segMin = picked.reduce((sum, s) => sum + (Number.isFinite(s.minutes) ? s.minutes : 0), 0);
  const ratio = segMin / cfg.baselineSegMin;
  const status = ratio >= THRESHOLDS.jam ? "JAM" : ratio >= THRESHOLDS.slow ? "SLOW" : "CLEAR";
  return {
    ...base,
    etaMinutes: Math.round(cfg.offPeakEtaMin * Math.max(1, ratio)),
    status,
    mood: MOODS[status],
    source: "lta",
    segmentMinutes: segMin,
    ratio: Math.round(ratio * 100) / 100,
    driveAt: travelTimes.at,
  };
}

// Queue level for one crossing and direction from its two cameras.
// Level 3+ only if both cameras agree (fresh, and both ≥ 3); then the lower of
// the two. Otherwise the highest reading, capped at 2. One camera alone ≤ 2.
function queueLevel(queue, crossing, dir, now) {
  const fresh = Object.entries(QUEUE_CAMERAS)
    .filter(([, c]) => c.crossing === crossing)
    .map(([id]) => ({ id, r: queue[id] }))
    .filter(({ r }) => r && r.at && r[dir] != null && ageMin(r.at, now) <= QUEUE_MAX_AGE_MIN);
  if (!fresh.length) return null;
  const vals = fresh.map(({ r }) => r[dir]);
  const agreed = fresh.length >= 2 && vals.every((v) => v >= QUEUE_STATUS_LEVELS.jam);
  const level = agreed ? Math.min(...vals) : Math.min(Math.max(...vals), QUEUE_STATUS_LEVELS.jam - 1);
  const at = fresh.map(({ r }) => r.at).sort()[0]; // the older of the readings used
  return { level, at, cameras: Object.fromEntries(fresh.map(({ id, r }) => [id, r[dir]])) };
}

// Turn the drive estimate into a [low, high] range using the queue level.
function applyQueue(d, crossing, q) {
  if (d.etaMinutes == null) return d;
  if (!q) return { ...d, etaLow: d.etaMinutes, etaHigh: d.etaMinutes, queueLevel: null };
  // TomTom: drive time + queue replaces the fixed checkpointMin. LTA: its
  // estimate already includes an off-peak crossing time, so add on top.
  const base = d.source === "tomtom" ? d.driveMin : d.etaMinutes;
  const [lo, hi] = QUEUE_MINUTES[crossing][q.level];
  const queueStatus = q.level >= QUEUE_STATUS_LEVELS.jam ? "JAM" : q.level >= QUEUE_STATUS_LEVELS.slow ? "SLOW" : "CLEAR";
  const status = worst(d.status, queueStatus);
  return {
    ...d,
    etaLow: base + lo,
    etaHigh: base + hi,
    etaMinutes: Math.round(base + (lo + hi) / 2),
    queueLevel: q.level,
    queueCameras: q.cameras,
    queueAt: q.at,
    status,
    mood: MOODS[status],
  };
}

function worst(a, b) {
  const rank = { UNKNOWN: -1, CLEAR: 0, SLOW: 1, JAM: 2 };
  return rank[a] >= rank[b] ? a : b;
}

// --- verdict ---------------------------------------------------------------
// One line per direction, from the minutes (range midpoints). The quip for a
// situation (which crossing is faster, how bad the slower one is) is kept while
// that situation holds, so the text only changes when the numbers do; when the
// situation changes, a different quip from the previous one is picked.

const QUIPS = {
  both_clear: ["Go go go.", "Rare day. Enjoy.", "Smooth like butter."],
  even: ["Toss a coin.", "Pick your favourite podcast.", "Bring kopi either way."],
  slower_CLEAR: ["Both fine, one's just shorter.", "No drama either way."],
  slower_SLOW: ["{slow}: bring kopi.", "{slow}: taking its time.", "{slow}: a little sticky."],
  slower_JAM: ["{slow}: bring a pillow.", "{slow}: pack snacks.", "{slow}: see you next week."],
  unknown: ["Peek at the cams below.", "Our crystal ball is cloudy."],
};

function computeVerdict(crossings, prev) {
  const byId = Object.fromEntries(crossings.map((c) => [c.id, c]));
  const out = {};
  for (const dir of ["to_jb", "to_sg"]) {
    const label = dir === "to_jb" ? "To JB" : "To SG";
    const w = byId.woodlands.directions[dir], t = byId.tuas.directions[dir];
    const p = prev && prev[dir];
    let situation, head, vars = {};
    if (w.etaMinutes == null || t.etaMinutes == null) {
      situation = "unknown";
      head = `${label}: no live numbers right now.`;
    } else {
      const diff = Math.abs(w.etaMinutes - t.etaMinutes);
      const fast = w.etaMinutes <= t.etaMinutes ? "woodlands" : "tuas";
      const slow = fast === "woodlands" ? "tuas" : "woodlands";
      const slowStatus = byId[slow].directions[dir].status;
      const round5 = (n) => Math.max(5, Math.round(n / 5) * 5);
      if (w.status === "CLEAR" && t.status === "CLEAR" && diff < 10) {
        situation = "both_clear";
        head = `${label}: both clear, ~${Math.min(w.etaMinutes, t.etaMinutes)} min.`;
      } else if (diff < 10) {
        situation = "even";
        head = `${label}: about even, ~${w.etaMinutes} vs ~${t.etaMinutes} min.`;
      } else {
        situation = `${fast}_faster_${slowStatus}`;
        head = `${label}: ${ROUTES[fast].short} ~${round5(diff)} min faster.`;
        vars.slow = ROUTES[slow].short;
      }
    }
    const pool = QUIPS[situation.startsWith("woodlands_") || situation.startsWith("tuas_") ? `slower_${situation.split("_").pop()}` : situation] || QUIPS.unknown;
    let idx;
    if (p && p.situation === situation && p.idx < pool.length) idx = p.idx;
    else {
      // New situation: random quip, but never the same text as the last one shown.
      const lastText = p && p.quip;
      const options = pool.map((q, i) => i).filter((i) => fill(pool[i], vars) !== lastText);
      const from = options.length ? options : pool.map((q, i) => i);
      idx = from[Math.floor(Math.random() * from.length)];
    }
    const quip = fill(pool[idx], vars);
    out[dir] = { situation, idx, quip, text: `${head} ${quip}` };
  }
  return out;
}

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

// --- /api/summary ----------------------------------------------------------

async function readRecord(env) {
  if (!env.STORE) return null;
  return memoize("record", TTL.state, () => env.STORE.get(STORE_KEY, { type: "json" }));
}

async function getSummary(request, env, ctx) {
  const notes = [];
  let record = await readRecord(env);
  if (!record) {
    // No KV yet (binding missing, or before the first cron run): compute a
    // per-instance live view without camera queue readings.
    notes.push(env.STORE ? "waiting for the first scheduled update" : "STORE KV binding is not set: numbers are per-instance");
    record = await memoize("live-fallback", TTL.liveFallback, async () => {
      const now = Date.now();
      const state = await collect(env, {}, now);
      return { state, view: computeView(state, now, null), updatedAt: new Date(now).toISOString() };
    });
  }

  let cameras = [];
  try {
    cameras = (await getCameras(request, ctx)).cameras;
  } catch (e) {
    notes.push(`cameras: ${errText(e)}`);
  }

  const view = record.view;
  return {
    dataAt: record.updatedAt,
    generatedAt: new Date().toISOString(),
    verdict: view.verdict,
    thresholds: view.thresholds,
    errors: (view.errors || []).concat(notes),
    crossings: view.crossings.map((c) => ({ ...c, cameras: cameras.filter((cam) => cam.crossing === c.id) })),
  };
}
