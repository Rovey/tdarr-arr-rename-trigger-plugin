# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions 1.1.0, 1.3.0 and 1.4.0 were never released under a tag of their own — their changes first shipped in [1.5.0], so those headings carry no release link.

## [1.6.0] - 2026-09-20

### Changed
- `rescan_wait_seconds` is now declared as a `string` input instead of a `number`. Tdarr casts inputs before the plugin runs — for a `number` input it applies `Number()` and rewrites `NaN` to `0` — so a value typed wrong in the flow (`abc`, `20s`) reached the plugin as `0`, meaning "never wait", and the 1.5.1 fallback never saw the original value. As a string the typed value arrives intact and the plugin's own parser falls back to 15 seconds. The field is a text box in the Tdarr UI either way and existing values keep working: `15` reads as 15 seconds, `0` still means never wait.
- The test harness uses a faithful copy of Tdarr's `loadDefaultValues` instead of a simplified stub, so this host-side casting is covered by the suite (27 tests).

## [1.5.1] - 2026-09-20

### Fixed
- `rescan_wait_seconds` was read as `parseInt(value, 10) || 0`, so any value that did not parse as a number became `0` — "never wait" — instead of the declared default of 15 seconds. The plugin then skipped the rescan poll and deferred every rename to a later run. The input now falls back to 15 for anything that is not a non-negative number; an explicit `0` still means "never wait".
- A wait of `0` logged `Rescan still busy — rename deferred to a later run.`, which claimed a rescan had been polled and found busy when no poll had happened at all. That case now logs `Not waiting for the rescan (rescan_wait_seconds = 0) — rename deferred to a later run.`; the old line is still used when a rescan genuinely outlives the wait.

### Added
- Test suite (`npm test`, Node's built-in runner, no dependencies and no network): 21 tests covering `details()`, both service paths, ID fallbacks, API-key resolution and the `rescan_wait_seconds` handling.

### Changed
- Internal: the near-identical Radarr and Sonarr branches share one parameterised flow again (the 1.2.1 refactor, redone on top of the current code). Log output, API calls and `details()` are unchanged — verified by a 57-scenario differential against 1.5.0 and by a live Tdarr run.

## [1.5.0] - 2026-07-28

### Added
- API keys can now be provided via environment variables (`RADARR_API_KEY`, `SONARR_API_KEY`) or a credentials file (`arr_credentials.json` next to the plugin, or `/app/configs/arr_credentials.json`). Resolution order: plugin input → env var → file.

### Security
- Tdarr dumps all plugin inputs into the worker log, so API keys configured as plugin inputs end up in plain text in the logs. Leave the `*_api_key` inputs empty and use the env var or credentials file instead to keep keys out of the logs. Input tooltips now warn about this.

## [1.4.0] - 2026-07-27

### Changed
- Renames are now fire-and-forget: the plugin no longer blocks the Tdarr worker waiting for rename commands to complete.
- The rescan wait is capped by a new `rescan_wait_seconds` input (default 15, `0` = never wait). If the rescan outlives the window, the rename is deferred and caught up by the next plugin run for that movie/series (pending renames are probed and fired at the start of every run).
- Worst-case plugin runtime drops from 60s+ to roughly the rescan wait window; typical runs finish in a few seconds.

## [1.3.0] - 2026-07-27

### Changed
- Series lookup now matches the file path against each series' folder path from the already-fetched series list, replacing up to ~90 sequential `GET /api/v3/episodefile?seriesId=X` calls with zero extra requests.
- `RefreshMovie`/`RefreshSeries` replaced by `RescanMovie`/`RescanSeries`: the rename only needs the on-disk state re-read, not a metadata-provider refresh.

### Note
- Versions 1.3.0+ are based on the 1.2.0 codebase; the internal shared-helper refactor from the 1.2.1 release was not carried forward.

## [1.2.1] - 2026-07-02

### Fixed
- The "✓ ... rename command sent successfully!" line is now only logged when the rename command actually reports `completed`. Previously it was still printed after a failed or timed-out rename, contradicting the `finished with status: failed` line right above it.

### Changed
- Internal refactor: the near-identical Radarr and Sonarr refresh → wait → probe → rename blocks are collapsed into shared helpers (`refreshProbeAndRename`, `postCommandAndWait`, `findByExternalIds`), removing ~120 duplicated lines. API calls and log output are unchanged. (Superseded — see note under 1.3.0.)
- The command-wait policy (60 s timeout, 1 s poll interval) is now defined once as named constants, and the poll-loop sleep reuses a single `Atomics.wait` buffer instead of allocating a new `SharedArrayBuffer` every second.

## [1.2.0] - 2026-05-05

### Fixed
- IMDB/TMDB/TVDB fallback lookup silently picking the wrong title. Radarr's `GET /api/v3/movie?imdbId=` is not honored server-side — the API returns the full library and the old code took `[0]`, which is whichever movie sorts alphabetically first. Both the Radarr and Sonarr fallbacks now filter the already-fetched library client-side instead of issuing a second (broken) request.

### Added
- Idempotent skip: after refresh completes, the plugin probes `GET /api/v3/rename?movieId=...` (or `?seriesId=...`) and skips the `RenameMovie`/`RenameSeries` API call when nothing is pending.
- Wait-for-rename: the rename command is also polled to completion before logging success, so the "✓ rename command sent successfully" line is no longer fire-and-forget.

### Technical Details
- Added `GET /api/v3/rename?movieId={id}` and `GET /api/v3/rename?seriesId={id}` probe calls.
- Reuses the `allMovies` / `allSeries` arrays already fetched for the file-path lookup — no extra API calls for the ID fallback.

## [1.1.0] - 2026-05-05

### Fixed
- Race condition where files transcoded by Tdarr were left with stale codec tags in their filename (e.g. `[DTS-HD MA 7.1][VC1]` instead of `[Vorbis 7.1][h265]`). The previous logic POSTed `RefreshMovie` and `RenameMovie` back-to-back; both returned `201` immediately because Radarr only queues the commands. Radarr's command worker could then execute the rename before the refresh's mediainfo rescan finished, so the rename evaluator compared the new filename against stale DB metadata, concluded it "matched", and skipped the rename. After the refresh later completed, the DB updated — but the file was already past the rename step and stayed misnamed. Same race existed for `RefreshSeries` / `RenameSeries`.

### Added
- `waitForCommand(host, apiKey, commandId, label)` helper that polls `GET /api/v3/command/{id}` once per second (60 s timeout) until status is `completed`, `failed`, or `aborted`. Called between refresh and rename.
- `Atomics.wait`-based synchronous sleep so the poll loop does not pin a CPU core (sync-request is blocking, so a regular `setTimeout` cannot be used inside the plugin).

### Technical Details
- Captures the command ID from the POST response (`refreshRes.getBody('utf8')` → `.id`) and polls until completion before issuing the rename.
- Same pattern applied to both Radarr and Sonarr branches.

## [1.0.0] - 2025-10-09

### Added
- Initial release of Tdarr Radarr/Sonarr Rename Trigger Plugin
- Path-based detection for Radarr and Sonarr
- Independent enable/disable toggles for each service
- Configurable path matching strings
- Primary lookup by exact file path matching
- Fallback lookup using IMDB, TMDB, and TVDB IDs
- Support for Radarr v3 API with correct command structure
- Support for Sonarr v3 API with episode file lookup
- IMDB ID support for Sonarr series lookup
- Optional refresh before rename functionality
- Detailed logging for debugging and monitoring
- Synchronous HTTP requests using sync-request library
- Comprehensive error handling

### Technical Details
- Radarr: GET /api/v3/movie and POST /api/v3/command (RefreshMovie, RenameMovie)
- Sonarr: GET /api/v3/series, GET /api/v3/episodefile, POST /api/v3/command (RefreshSeries, RenameSeries)
- Uses movieIds/seriesIds arrays for command parameters (verified against Radarr source code)
- ID extraction from file paths: IMDB (tt\d+), TMDB (tmdbid-\d+), TVDB (tvdbid-\d+)

[1.6.0]: https://github.com/Rovey/tdarr-arr-rename-trigger-plugin/releases/tag/v1.6.0
[1.5.1]: https://github.com/Rovey/tdarr-arr-rename-trigger-plugin/releases/tag/v1.5.1
[1.5.0]: https://github.com/Rovey/tdarr-arr-rename-trigger-plugin/releases/tag/v1.5.0
[1.2.1]: https://github.com/Rovey/tdarr-arr-rename-trigger-plugin/releases/tag/v1.2.1
[1.2.0]: https://github.com/Rovey/tdarr-arr-rename-trigger-plugin/releases/tag/v1.2.0
[1.0.0]: https://github.com/Rovey/tdarr-arr-rename-trigger-plugin/releases/tag/v1.0.0
