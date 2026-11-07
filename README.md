# JamOrNot

Live traffic at the two Singapore–Malaysia crossings (Woodlands Causeway and Tuas Second Link), in both directions. It's a static site on Cloudflare Pages backed by one small Cloudflare Worker that serves JSON.

The site is at <https://jamornot.pages.dev>. The Worker keeps its original name, `causeway-watch-api`, because renaming it would change the API's address.

```
public/            static site (Cloudflare Pages)
  index.html
  style.css
  app.js           rendering, Refresh button, 3-min auto-refresh
worker/            JSON API + cron (Cloudflare Worker)
  worker.js        all tunables at the top
  wrangler.toml    cron trigger, KV and AI bindings
```

## How data flows

Every visitor sees the same numbers, because they all read one stored result:

1. **Every 10 minutes a cron run** fetches the TomTom drive times, the LTA expressway times and **one** camera queue reading. It computes everything the page shows (ETAs, statuses, verdict) and writes it to **one KV record**. If nothing but timestamps changed it skips the write. It still writes at least every 20 minutes so the ages stay honest.
2. **Page loads only read that record.** They never call TomTom or the AI model. Camera thumbnails are the one live part: they come straight from data.gov.sg, because the images change every minute.
3. **Every value has a timestamp.** Routes and LTA times have `at`, each direction has `driveAt` and `queueAt`, and the record has `updatedAt`. The page's "Updated Xm ago" is the record's `updatedAt`, so it's the age of the data, not of your page load.

The Cache API can't be the shared store: on `*.workers.dev` it does nothing, and a cron run can't use it either. So this uses KV. The free tier allows 1,000 writes a day, and this makes at most 144.

| Endpoint | What it returns |
|---|---|
| `GET /api/summary` | what the page shows: the stored result plus live camera thumbnails |
| `GET /api/state` | the raw stored record: routes, LTA times, queue readings, with timestamps |
| `GET /api/routes`, `/api/travel-times`, `/api/queue` | parts of `/api/state` |
| `GET /api/cameras` | live camera list (cams 2701, 2702, 2704, 4703, 4712, 4713) |

## How the estimate works

- **Drive time:** TomTom's live drive time for a fixed route across each crossing, from the expressway on one side to past the far checkpoint (about 10 km). If TomTom fails, or its last value is over 30 minutes old, the Worker uses LTA expressway times instead.
- **Queue (prototype):** TomTom barely sees the stop-start crawl at the checkpoints. So a Workers AI vision model (`llama-3.2-11b-vision-instruct`) rates the queue each way on two cameras per crossing, from 0 (free-flowing) to 4 (standstill): 2701 and 2702 for Woodlands, 4712 and 4713 for Tuas. The cron reads one camera per run, so each camera is read every 40 minutes and the two cameras for a crossing are read 10 minutes apart. Readings over 90 minutes old are ignored.
- **Both cameras must agree before JAM.** A level of 3 or more only counts if both cameras for that direction say 3 or more; then the lower of the two is used. Otherwise the level is capped at 2. A single bad reading can't turn a direction red.
- **The range:** drive time plus the minutes for that queue level (`QUEUE_MINUTES`). For example, Woodlands level 4 adds 90–150 minutes. Without a fresh camera reading, the page shows a single number: drive time plus a flat 10 minutes.
- **Status:** CLEAR, SLOW or JAM, whichever is worse of the traffic delay and the queue level:

| Status | Traffic delay (live minus no-traffic drive time) | or camera queue |
|---|---|---|
| CLEAR | under 10 min | level 0–1 |
| SLOW | 10–29 min | level 2 |
| JAM | 30+ min | level 3–4 on **both** cameras for that direction |

  LTA fallback: SLOW from 1.3× the off-peak time, JAM from 1.8×. The page explains all of this under "How to read these numbers", using the Worker's own thresholds.
- **Verdict:** one line per direction, worked out from the minutes, e.g. "To JB: Tuas ~65 min faster. Woodlands: pack snacks." The quip stays the same while the situation does (which crossing is faster, and how bad the slower one is). So the text only changes when the numbers do, and a new quip is never the same as the last one.

**Things to tune**, all at the top of `worker/worker.js`:
- `CAMERAS`: thumbnail cameras and their direction
- `TOMTOM_ROUTES`: start/end points per direction (check with `/api/routes`: each should be about 8–12 km)
- `DELAY_THRESHOLDS_MIN`, `QUEUE_STATUS_LEVELS`, `THRESHOLDS`: when SLOW and JAM kick in
- `QUEUE_CAMERAS`: which cameras the model reads, with a hint saying where each direction's lanes are in the frame
- `QUEUE_MINUTES`: minutes added per queue level, `[low, high]`
- `QUEUE_ROTATION`: the order cameras are read in (one per 10-min run)
- `QUIPS`: the verdict's jokes
- `ROUTES`: the LTA fallback's segments and baselines

## Setup

### 1. Get an LTA DataMall key
Request a free API key at <https://datamall.lta.gov.sg> (Request for API Access). The key arrives by email as your `AccountKey`.

### 1b. Get a TomTom key (optional, for better ETAs)
Sign up at <https://developer.tomtom.com>, then copy the API key from your dashboard. The cron makes 4 calls every 10 minutes, about 576 a day, well inside the free tier.

### 1c. Workers AI (for the camera queue estimate)
Nothing to sign up for: `wrangler.toml` already has the `[ai]` binding. The Worker accepts Meta's model licence automatically on first use. It makes about 144 reads a day, roughly 1,500–5,000 of the free 10,000 neurons. On the Free plan, going over just pauses the estimate until the next day.

### 1d. KV store and cron (one-time)
```sh
cd worker
npx wrangler kv namespace create STORE
```
Paste the `id` it prints into `wrangler.toml`, replacing `PASTE_KV_NAMESPACE_ID_HERE`. The cron schedule (`*/10 * * * *`) is already in `wrangler.toml` under `[triggers]`.

If you deploy from the dashboard instead of `wrangler deploy`, add these under the Worker's **Settings**: a **KV namespace** binding named `STORE`, a **Workers AI** binding named `AI`, and a **Cron Trigger** `*/10 * * * *`.

### 2. Deploy the Worker
```sh
cd worker
npx wrangler login
npx wrangler secret put LTA_ACCOUNT_KEY   # paste the DataMall AccountKey
npx wrangler secret put TOMTOM_KEY        # optional: paste the TomTom API key
npx wrangler deploy
```
Test it: `curl https://<worker-url>/api/summary`. Until the first cron run (up to 10 minutes after deploying), `errors` says "waiting for the first scheduled update" and the numbers have no camera queue estimate. Check `/api/state` afterwards: `updatedAt` should be at most about 20 minutes old.

**Check the TomTom routes once.** Open `/api/routes`. Each route should be roughly 8–12 km. If one is much longer, a start or end point snapped to the wrong road: paste its `from`/`to` into Google Maps and move it in `TOMTOM_ROUTES`.

### 3. Deploy the site to Pages
```sh
npx wrangler pages deploy public --project-name jamornot
```
Or connect this repo in the Cloudflare dashboard (Workers & Pages → Create → Pages → connect Git). Leave the build command empty and set the output directory to `public`.

### 4. Point the site at the API
- **Same domain (recommended):** give the Pages project the custom domain `causeway.example.com` and route the Worker at `causeway.example.com/api/*`. Leave `<meta name="api-base" content="">` in `index.html` empty.
- **Separate Worker URL:** set `<meta name="api-base" content="https://causeway-watch-api.<you>.workers.dev">`. The Worker sends `Access-Control-Allow-Origin: *`.

## Local dev
```sh
cd worker && npx wrangler dev --test-scheduled --var LTA_ACCOUNT_KEY:<your key>   # http://localhost:8787
curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"   # run the cron once
```
Then set `api-base` to `http://localhost:8787` and serve `public/` with any static server, for example `npx serve public`.
