# SCJC + cder bridge v2.5.0

Nuvio/Stremio-compatible bridge over a configured cder Stream Cinema addon.

## What it does

- Proxies cder catalogs, metadata and streams.
- Does **not** perform direct KRA login or Stream Cinema `/auth/token` calls.
- Converts catalog items to standard IMDb `tt...` IDs when available, so other installed stream add-ons can independently match the same title.
- Adds CZ/SK dubbed catalogs, music/concert catalogs, and search for movies, series and concerts.
- Sorts Stream Cinema streams by CZ/SK dubbing first, then file size, then quality.
- Adds stream labels for language, resolution, HDR/Dolby Vision, Atmos/DTS:X, codec and file size.
- Uses bounded TTL caching, request coalescing, concurrency limits and 429 backoff.

## Install

Production manifest:

`https://nuvio-scjc-addon.onrender.com/manifest.json`

Status:

`https://nuvio-scjc-addon.onrender.com/health`

## Environment

Required:
- `CDER_MANIFEST_URL` — configured cder manifest URL.

Optional:
- `CDER_MAX_CONCURRENCY` — default `3`.
- `CDER_BACKOFF_MS` — default `300000`.
- `CDER_TIMEOUT_MS` — default `10000`.
- `CACHE_MAX_ENTRIES` — default `2000`.
- `ID_MAP_MAX_ENTRIES` — default `5000`.

## Safety model

The bridge never creates or refreshes Stream Cinema tokens and never logs the cder manifest URL. When cder returns HTTP 429, the bridge enters backoff and serves stale cached data when available.
