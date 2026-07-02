# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-07-02

### Fixed
- The "✓ ... rename command sent successfully!" line is now only logged when the rename command actually reports `completed`. Previously it was still printed after a failed or timed-out rename, contradicting the `finished with status: failed` line right above it.

### Changed
- Internal refactor: the near-identical Radarr and Sonarr refresh → wait → probe → rename blocks are collapsed into shared helpers (`refreshProbeAndRename`, `postCommandAndWait`, `findByExternalIds`), removing ~120 duplicated lines. API calls and log output are unchanged.
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

[1.2.1]: https://github.com/Rovey/Tdarr-arr-rename-trigger-plugin/releases/tag/v1.2.1
[1.2.0]: https://github.com/Rovey/Tdarr-arr-rename-trigger-plugin/releases/tag/v1.2.0
[1.0.0]: https://github.com/Rovey/Tdarr-arr-rename-trigger-plugin/releases/tag/v1.0.0
