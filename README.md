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
| `GET /api/summary` | both of the above, combined per crossing and direction | 60s |

Caching uses the Cloudflare Cache API (`caches.default`). No KV.

**About the ETA:** it's an estimate. For each direction the Worker adds up the current BKE or AYE segment times and divides by an off-peak baseline. That ratio scales an off-peak crossing time:
`ETA = offPeakEtaMin × max(1, now / baselineSegMin)`.
Status is `CLEAR` below 1.3×, `SLOW` from 1.3×, and `JAM` from 1.8×. LTA doesn't publish checkpoint queue times, so a long jam at the checkpoint itself won't always show up. The cameras are the ground truth.

**Things to tune**, all at the top of `worker/worker.js`:
- `CAMERAS`: camera IDs and their direction
- `ROUTES`: which segments to use (`farEnd` keywords), `baselineSegMin`, `offPeakEtaMin`
- `THRESHOLDS`: the SLOW and JAM ratios

Verdict lines are in `VERDICTS` at the top of `public/app.js`.

## Setup

### 1. Get an LTA DataMall key
Request a free API key at <https://datamall.lta.gov.sg> (Request for API Access). The key arrives by email as your `AccountKey`.

### 2. Deploy the Worker
```sh
cd worker
npx wrangler login
npx wrangler secret put LTA_ACCOUNT_KEY   # paste the DataMall AccountKey
npx wrangler deploy
```
Test it: `curl https://<worker-url>/api/summary`

> **Caching needs a custom domain.** `caches.default` does nothing on `*.workers.dev`. The Worker still runs there, but every request hits the upstream APIs. For real caching, add a domain on Cloudflare and uncomment the `routes` line in `wrangler.toml`, for example `causeway.example.com/api/*`.

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
