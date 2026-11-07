# Causeway Watch

Live traffic at the two Singapore–Malaysia crossings (Woodlands Causeway and Tuas Second Link), in both directions. It's a static site on Cloudflare Pages backed by one small Cloudflare Worker that serves JSON.

```
public/            static site (Cloudflare Pages)
  index.html
  style.css
  app.js           verdict lines, rendering, 60s auto-refresh
worker/            JSON API (Cloudflare Worker)
  worker.js        camera IDs, routes, baselines, thresholds at the top
  wrangler.toml
```

## API

| Endpoint | Source | Cache |
|---|---|---|
| `GET /api/cameras` | data.gov.sg Traffic Images (cams 2701, 2702, 2704, 4703, 4712, 4713) | 60s |
| `GET /api/travel-times` | LTA DataMall Estimated Travel Times, BKE + AYE only | 120s |
| `GET /api/routes` | TomTom live-traffic drive time across each crossing (4 routes) | 180s |
| `GET /api/summary` | all of the above, combined per crossing and direction | 60s |
| `GET /api/queue` | latest camera queue readings (prototype, for calibration) | none |

Caching uses the Cloudflare Cache API (`caches.default`). No KV.

**About the ETA:** it's an estimate, from one of two sources per direction:
- **TomTom (preferred, when `TOMTOM_KEY` is set):** live drive time for a fixed route across the crossing, from the expressway on one side to past the checkpoint on the other. This includes the crawl on the bridge. `ETA = TomTom drive time + checkpointMin` (time inside immigration, which no traffic data sees). Status comes from the delay (TomTom live travel time minus its no-traffic time): `SLOW` from 10 min, `JAM` from 30 min.
- **LTA (fallback):** if TomTom isn't set up or a route fails, the Worker adds up the BKE or AYE segment times and divides by an off-peak baseline: `ETA = offPeakEtaMin × max(1, now / baselineSegMin)`. Status is `CLEAR` below 1.3×, `SLOW` from 1.3×, `JAM` from 1.8×. This only sees the Singapore expressway, not the bridge or the checkpoints.

Each direction in `/api/summary` has a `source` field (`tomtom` or `lta`).

**Camera queue estimate (prototype).** TomTom barely sees the stop-start crawl at the checkpoints, so a Workers AI vision model (`llama-3.2-11b-vision-instruct`) rates the queue each way on cameras 2701, 2702, 4712 and 4713, from 0 (free-flowing) to 4 (standstill). The level adds a range of minutes (`QUEUE_MINUTES`) to the drive time, and the page shows it as a range, e.g. `126–186 min est.`. It runs in the background: each `/api/summary` uses the latest readings and re-reads at most one stale camera after responding, so nobody waits on the model. Each camera is re-read at most every 15 min. Level 3+ makes the status JAM; level 2 makes it at least SLOW. `/api/queue` shows each camera's latest levels and the model's raw reply. The minute ranges are calibrated against one Saturday-evening reading, so treat them as a first guess.

**Things to tune**, all at the top of `worker/worker.js`:
- `CAMERAS`: camera IDs and their direction
- `ROUTES`: which segments to use (`farEnd` keywords), `baselineSegMin`, `offPeakEtaMin`
- `THRESHOLDS`: the SLOW and JAM ratios (LTA)
- `TOMTOM_ROUTES`: start/end points and `checkpointMin` per direction
- `DELAY_THRESHOLDS_MIN`: SLOW and JAM delay in minutes (TomTom)
- `QUEUE_CAMERAS`: which cameras to read, with a hint telling the model which lanes go which way
- `QUEUE_MINUTES`: minutes added per queue level, `[low, high]`
- `QUEUE_TTL`: how often each camera is re-read

Verdict lines are in `VERDICTS` at the top of `public/app.js`.

## Setup

### 1. Get an LTA DataMall key
Request a free API key at <https://datamall.lta.gov.sg> (Request for API Access). The key arrives by email as your `AccountKey`.

### 1b. Get a TomTom key (optional, for better ETAs)
Sign up at <https://developer.tomtom.com>, then copy the API key from your dashboard. The free tier covers this app: 4 routes every 3 minutes is about 1,920 calls a day. Check TomTom's current free limits.

### 1c. Workers AI (for the camera queue estimate)
Nothing to sign up for: `wrangler.toml` already has the `[ai]` binding, so `wrangler deploy` connects it. If you deploy from the dashboard instead, add a **Workers AI** binding named `AI` under the Worker's **Settings → Bindings**. The Worker accepts Meta's model licence automatically on first use. Usage counts against the free 10,000 neurons a day. On the Free plan, going over just pauses the estimate until the next day; on the Paid plan the extra is billed. You can watch usage in the dashboard under **AI → Workers AI**.

### 2. Deploy the Worker
```sh
cd worker
npx wrangler login
npx wrangler secret put LTA_ACCOUNT_KEY   # paste the DataMall AccountKey
npx wrangler secret put TOMTOM_KEY        # optional: paste the TomTom API key
npx wrangler deploy
```
Test it: `curl https://<worker-url>/api/summary`

**Check the TomTom routes once.** Open `/api/routes`. Each route should be roughly 8–12 km. If one is much longer, a start or end point snapped to the wrong road: paste its `from`/`to` into Google Maps and move it in `TOMTOM_ROUTES`.

> **Caching needs a custom domain.** `caches.default` does nothing on `*.workers.dev`. The Worker also keeps an in-memory copy per instance, which limits upstream calls, but Cloudflare runs many instances, so on `workers.dev` you can still use more TomTom quota than expected. For real caching, add a domain on Cloudflare and uncomment the `routes` line in `wrangler.toml`, for example `causeway.example.com/api/*`.

### 3. Deploy the site to Pages
```sh
npx wrangler pages deploy public --project-name causeway-watch
```
Or connect this repo in the Cloudflare dashboard (Workers & Pages → Create → Pages → connect Git). Leave the build command empty and set the output directory to `public`.

### 4. Point the site at the API
- **Same domain (recommended):** give the Pages project the custom domain `causeway.example.com` and route the Worker at `causeway.example.com/api/*`. Leave `<meta name="api-base" content="">` in `index.html` empty.
- **Separate Worker URL:** set `<meta name="api-base" content="https://causeway-watch-api.<you>.workers.dev">`. The Worker sends `Access-Control-Allow-Origin: *`.

## Local dev
```sh
cd worker && npx wrangler dev --var LTA_ACCOUNT_KEY:<your key>   # http://localhost:8787
```
Then set `api-base` to `http://localhost:8787` and serve `public/` with any static server, for example `npx serve public`.
