// Causeway Watch API: a single Cloudflare Worker.
// Endpoints: GET /api/cameras, GET /api/travel-times, GET /api/routes, GET /api/summary
// Caching: Cloudflare Cache API (caches.default) only. No KV.

// ---------------------------------------------------------------------------
// CONFIG: edit these freely
// ---------------------------------------------------------------------------

// Traffic cameras to keep. Add/remove IDs here.
// direction: "to_jb" | "to_sg"; crossing: key from ROUTES below.
const CAMERAS = [
  { id: "2701", crossing: "woodlands", direction: "to_jb", name: "Woodlands Causeway (towards JB)" },
  { id: "2702", crossing: "woodlands", direction: "to_sg", name: "Woodlands Checkpoint to BKE" },
  { id: "2704", crossing: "woodlands", direction: "to_jb", name: "BKE to Woodlands Checkpoint" },
  { id: "4703", crossing: "tuas", direction: "to_jb", name: "Tuas Second Link (towards JB)" },
  { id: "4712", crossing: "tuas", direction: "to_jb", name: "AYE Tuas Ave 8 exit" },
  { id: "4713", crossing: "tuas", direction: "to_sg", name: "Tuas Checkpoint" },
];

// Expressways whose segments we keep from LTA Estimated Travel Times.
const EXPRESSWAYS = ["BKE", "AYE"];

// Per crossing, per direction: which expressway segments to sum, and the
// off-peak baselines used to turn "segment minutes now" into an ETA estimate.
//   farEnd:          keep segments whose FarEndPoint contains any of these words
//   fallbackDir:     LTA Direction (1/2) used if no FarEndPoint matches
//   baselineSegMin:  off-peak sum of the matching segment times (minutes)
//   offPeakEtaMin:   off-peak time to get across, checkpoint included (minutes)
// ETA = offPeakEtaMin * (segment minutes now / baselineSegMin), never below offPeakEtaMin.
const ROUTES = {
  woodlands: {
    name: "Woodlands Causeway",
    to_jb: { label: "To JB", subtitle: "BKE → Woodlands Checkpoint", expressway: "BKE", farEnd: ["WOODLANDS"], fallbackDir: 1, baselineSegMin: 8, offPeakEtaMin: 20 },
    to_sg: { label: "To SG", subtitle: "Woodlands Checkpoint → BKE", expressway: "BKE", farEnd: ["PIE"], fallbackDir: 2, baselineSegMin: 8, offPeakEtaMin: 25 },
  },
  tuas: {
    name: "Tuas Second Link",
    to_jb: { label: "To JB", subtitle: "AYE → Tuas Checkpoint", expressway: "AYE", farEnd: ["TUAS"], fallbackDir: 1, baselineSegMin: 20, offPeakEtaMin: 15 },
    to_sg: { label: "To SG", subtitle: "Tuas Checkpoint → AYE", expressway: "AYE", farEnd: ["CITY", "MCE", "MARINA", "SHENTON", "KEPPEL"], fallbackDir: 2, baselineSegMin: 20, offPeakEtaMin: 18 },
  },
};

// Status thresholds on the ratio (segment minutes now / off-peak baseline).
const THRESHOLDS = { slow: 1.3, jam: 1.8 };
const MOODS = { CLEAR: "chill", SLOW: "busy", JAM: "crowded", UNKNOWN: "mystery" };

// TomTom live-traffic routes across each crossing (used when TOMTOM_KEY is set;
// LTA estimate above is the fallback). Points are "lat,lon".
// Check a route by pasting from/to into Google Maps; /api/routes shows routeKm.
//   checkpointMin: time spent inside immigration (not in any traffic data), added to the drive time
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
// Status from TomTom's traffic delay (minutes over free-flow).
const DELAY_THRESHOLDS_MIN = { slow: 10, jam: 30 };

// routes: 4 TomTom calls per refresh. 180s ≈ 1,920 calls/day, inside the free tier.
const TTL = { cameras: 60, travelTimes: 120, routes: 180, summary: 60 };

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
        case "/api/cameras":
          return json(await getCameras(request, ctx), 200, TTL.cameras);
        case "/api/travel-times":
          return json(await getTravelTimes(request, env, ctx), 200, TTL.travelTimes);
        case "/api/routes":
          return json(await getRoutes(request, env, ctx), 200, TTL.routes);
        case "/api/summary":
          return json(await getSummary(request, env, ctx), 200, TTL.summary);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 502);
    }
  },
};

function json(data, status = 200, ttl = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": ttl ? `public, max-age=${Math.min(ttl, 30)}` : "no-store",
      ...CORS,
    },
  });
}

// Read-through cache on caches.default. The key lives under the Worker's own
// origin so it is scoped to your zone. caches.default is a no-op on
// *.workers.dev, so there is also a per-isolate in-memory copy: not shared
// between Cloudflare locations, but it stops one busy isolate from calling
// upstream (and burning TomTom quota) on every request.
const memo = new Map();

async function cached(request, ctx, key, ttl, produce) {
  const m = memo.get(key);
  if (m && m.expires > Date.now()) return m.data;

  const cache = globalThis.caches && globalThis.caches.default;
  const cacheKey = new Request(new URL(`/__cache/${key}`, request.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
  }
  const data = await produce();
  memo.set(key, { data, expires: Date.now() + ttl * 1000 });
  if (cache) {
    const res = new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` },
    });
    ctx.waitUntil(cache.put(cacheKey, res));
  }
  return data;
}

// --- /api/cameras ----------------------------------------------------------

function getCameras(request, ctx) {
  return cached(request, ctx, "cameras-v1", TTL.cameras, async () => {
    const res = await fetch(TRAFFIC_IMAGES_URL, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`traffic-images upstream ${res.status}`);
    const body = await res.json();
    const all = (body.items && body.items[0] && body.items[0].cameras) || [];
    const byId = new Map(all.map((c) => [String(c.camera_id), c]));
    const cameras = CAMERAS.filter((c) => byId.has(c.id)).map((c) => {
      const cam = byId.get(c.id);
      return {
        id: c.id,
        name: c.name,
        crossing: c.crossing,
        direction: c.direction,
        imageUrl: cam.image,
        timestamp: cam.timestamp,
      };
    });
    return { updatedAt: new Date().toISOString(), cameras };
  });
}

// --- /api/travel-times -----------------------------------------------------

function getTravelTimes(request, env, ctx) {
  return cached(request, ctx, "travel-times-v1", TTL.travelTimes, async () => {
    if (!env.LTA_ACCOUNT_KEY) throw new Error("LTA_ACCOUNT_KEY secret is not set");
    const rows = [];
    for (let skip = 0; skip < 2500; skip += 500) {
      const url = skip ? `${LTA_TRAVEL_TIMES_URL}?$skip=${skip}` : LTA_TRAVEL_TIMES_URL;
      const res = await fetch(url, {
        headers: { AccountKey: env.LTA_ACCOUNT_KEY, accept: "application/json" },
      });
      if (!res.ok) throw new Error(`LTA upstream ${res.status}`);
      const page = (await res.json()).value || [];
      rows.push(...page);
      if (page.length < 500) break;
    }
    const segments = rows
      .filter((r) => EXPRESSWAYS.includes(String(r.Name).toUpperCase()))
      .map((r) => ({
        expressway: String(r.Name).toUpperCase(),
        direction: Number(r.Direction),
        farEnd: r.FarEndPoint,
        start: r.StartPoint,
        end: r.EndPoint,
        minutes: Number(r.EstTime),
      }));
    return { updatedAt: new Date().toISOString(), segments };
  });
}

// --- /api/routes (TomTom live traffic) -------------------------------------

function getRoutes(request, env, ctx) {
  return cached(request, ctx, "routes-v1", TTL.routes, async () => {
    if (!env.TOMTOM_KEY) throw new Error("TOMTOM_KEY secret is not set");
    const jobs = [];
    for (const [crossing, dirs] of Object.entries(TOMTOM_ROUTES)) {
      for (const [dir, cfg] of Object.entries(dirs)) {
        jobs.push(fetchRoute(cfg, env.TOMTOM_KEY).then(
          (r) => [crossing, dir, r],
          (e) => [crossing, dir, { error: String(e && e.message || e) }],
        ));
      }
    }
    const routes = {};
    for (const [crossing, dir, r] of await Promise.all(jobs)) {
      (routes[crossing] ||= {})[dir] = r;
    }
    return { updatedAt: new Date().toISOString(), routes };
  });
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
  };
}

// --- /api/summary ----------------------------------------------------------

function getSummary(request, env, ctx) {
  return cached(request, ctx, "summary-v2", TTL.summary, async () => {
    const [cams, times, routesRes] = await Promise.allSettled([
      getCameras(request, ctx),
      getTravelTimes(request, env, ctx),
      env.TOMTOM_KEY ? getRoutes(request, env, ctx) : Promise.resolve(null),
    ]);
    const cameras = cams.status === "fulfilled" ? cams.value.cameras : [];
    const segments = times.status === "fulfilled" ? times.value.segments : null;
    const routes = routesRes.status === "fulfilled" && routesRes.value ? routesRes.value.routes : {};
    const routeErrors = [];

    const crossings = Object.entries(ROUTES).map(([id, route]) => {
      const directions = {};
      for (const dir of ["to_jb", "to_sg"]) {
        // Prefer TomTom live traffic; fall back to the LTA expressway estimate.
        const r = routes[id] && routes[id][dir];
        const cfg = TOMTOM_ROUTES[id] && TOMTOM_ROUTES[id][dir];
        if (r && cfg && !r.error) {
          directions[dir] = estimateTomTom({ label: route[dir].label, subtitle: cfg.via }, cfg, r);
        } else {
          if (r && r.error) routeErrors.push(`${id}/${dir}: ${r.error}`);
          directions[dir] = estimate(route[dir], segments);
        }
      }
      const status = worst(directions.to_jb.status, directions.to_sg.status);
      return {
        id,
        name: route.name,
        status,
        mood: MOODS[status],
        directions,
        cameras: cameras.filter((c) => c.crossing === id),
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      travelTimesUpdatedAt: times.status === "fulfilled" ? times.value.updatedAt : null,
      camerasUpdatedAt: cams.status === "fulfilled" ? cams.value.updatedAt : null,
      errors: [cams, times, routesRes]
        .filter((r) => r.status === "rejected")
        .map((r) => String(r.reason && r.reason.message || r.reason))
        .concat(routeErrors),
      crossings,
    };
  });
}

function estimate(cfg, segments) {
  const base = { label: cfg.label, subtitle: cfg.subtitle, etaMinutes: null, status: "UNKNOWN", mood: MOODS.UNKNOWN };
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
  };
}

function worst(a, b) {
  const rank = { UNKNOWN: -1, CLEAR: 0, SLOW: 1, JAM: 2 };
  return rank[a] >= rank[b] ? a : b;
}
