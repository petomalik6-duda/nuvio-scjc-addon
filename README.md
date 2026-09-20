# SCJC cder Catalogs v2.8.0

SCJC is a **catalog-only** extension for a separately configured/installed club.cder addon.

## Architecture

- **club.cder** owns KRA/Stream Cinema authentication, metadata and streams.
- **SCJC** only builds extra CZ/SK dubbed, music/concert and search catalogs from club.cder catalog data.
- SCJC publishes standard IMDb `tt...` IDs so Nuvio can ask club.cder and other installed stream addons for the actual detail and streams.
- SCJC does not perform direct KRA login, does not create Stream Cinema tokens, and does not proxy `meta` or `stream` resources.

## Shared cache across web-service restarts

v2.8 adds a separate Render Key Value cache:

- raw club.cder catalog responses are stored outside the SCJC web process;
- already filtered SCJC catalog state is stored outside the SCJC web process;
- after a Render sleep/restart, SCJC restores these values before considering a new club.cder request;
- normal source catalog data is fresh for 6 hours;
- derived SCJC catalog state is fresh for 6 hours;
- search data is fresh for 30 minutes;
- stored values are retained for up to 7 days as stale fallback;
- RAM cache is still used as the fastest first layer.

The free Render Key Value plan has no disk-backed persistence. It survives SCJC web-service restarts because it is a separate service, but its cache can be lost if the Key Value instance itself is restarted or upgraded. A paid Key Value plan would add disk-backed persistence.

## Traffic safety

- only one club.cder request can run at a time;
- minimum 2 seconds between actual upstream requests;
- maximum 8 real club.cder fetches per 15-minute process window;
- a derived catalog processes at most one new source page per client request;
- at most 8 source pages are scanned for normal catalogs and 2 for search;
- HTTP 401/403/404/429 and catalog timeouts open a long backoff;
- health checks, startup and CI tests never call club.cder;
- persistent-cache reads happen before the upstream request budget is consumed.

## Install

Production manifest:

`https://nuvio-scjc-addon.onrender.com/manifest.json`

Status:

`https://nuvio-scjc-addon.onrender.com/health`

## Environment

Required:
- `CDER_MANIFEST_URL` — configured club.cder manifest URL.
- `REDIS_URL` — internal Render Key Value connection string.

Optional:
- `CDER_MIN_INTERVAL_MS` — enforced minimum is 2000 ms.
- `CDER_BACKOFF_MS` — enforced minimum is 1 hour.
- `CDER_BUDGET_MAX` — default 8.
- `CDER_BUDGET_WINDOW_MS` — default 15 minutes.
- `CDER_TIMEOUT_MS` — default 10000 ms.
- `CACHE_MAX_ENTRIES` — default 2000.
- `ID_MAP_MAX_ENTRIES` — default 5000.

No credentials or configured club.cder URL are logged.
