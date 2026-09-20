# SCJC cder Catalogs v2.7.0

SCJC is now a **catalog-only** extension for a separately configured/installed club.cder addon.

## Architecture

- **club.cder** owns KRA/Stream Cinema authentication, metadata and streams.
- **SCJC** only builds extra CZ/SK dubbed, music/concert and search catalogs from club.cder catalog data.
- SCJC publishes standard IMDb `tt...` IDs so Nuvio can ask club.cder and other installed stream addons for the actual detail and streams.
- SCJC does not perform direct KRA login, does not create Stream Cinema tokens, and no longer proxies `meta` or `stream` resources.

## Traffic safety

To avoid triggering upstream blocking:

- only one club.cder request can run at a time;
- minimum 2 seconds between actual upstream requests;
- maximum 8 real club.cder fetches per 15-minute process window;
- a derived catalog processes at most one new source page per client request;
- at most 8 source pages are scanned for normal catalogs and 2 for search;
- catalog source responses are cached for 1 hour;
- derived catalog state is cached for 2 hours;
- HTTP 401/403/404/429 and catalog timeouts open a long backoff;
- health checks, startup and CI tests never call club.cder.

## Install

Production manifest:

`https://nuvio-scjc-addon.onrender.com/manifest.json`

Status:

`https://nuvio-scjc-addon.onrender.com/health`

## Environment

Required:
- `CDER_MANIFEST_URL` — configured club.cder manifest URL.

Optional:
- `CDER_MIN_INTERVAL_MS` — enforced minimum is 2000 ms.
- `CDER_BACKOFF_MS` — enforced minimum is 1 hour.
- `CDER_BUDGET_MAX` — default 8.
- `CDER_BUDGET_WINDOW_MS` — default 15 minutes.
- `CDER_TIMEOUT_MS` — default 10000 ms.
- `CACHE_MAX_ENTRIES` — default 2000.
- `ID_MAP_MAX_ENTRIES` — default 5000.

No credential or configured club.cder URL is logged.
