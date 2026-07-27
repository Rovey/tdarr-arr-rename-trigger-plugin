# Tdarr Radarr/Sonarr Rename Trigger Plugin

A Tdarr post-processing plugin that automatically triggers Radarr or Sonarr to rename media files after transcoding is complete.

## Features

- 🎬 **Radarr Support**: Automatically rename movies after transcoding
- 📺 **Sonarr Support**: Automatically rename TV series episodes after transcoding
- 🔍 **Smart Detection**: Path-based detection with configurable path matching
- 🎯 **Accurate Lookup**: Instant series/movie lookup via folder-path matching, fallback to IMDB/TMDB/TVDB IDs (client-side filtered against the full library to avoid Radarr's ignored-query-param footgun)
- ⚙️ **Flexible Configuration**: Enable/disable services independently with custom path filters
- 🔄 **Disk Rescan Before Rename**: Triggers a disk-only rescan (no metadata provider hit) so the new file is detected
- ⚡ **Non-Blocking**: Renames are fire-and-forget and rescans wait at most a configurable number of seconds — big-series rescans no longer stall the Tdarr worker
- 🔐 **Log-Safe API Keys**: Keys can come from env vars or a credentials file, keeping them out of Tdarr's worker logs
- 📝 **Detailed Logging**: Comprehensive logs for debugging and monitoring

## Installation

1. Copy `Tdarr_Plugin_rovey_arr_rename_trigger.js` to your Tdarr plugins directory:
   - **Docker**: `/app/server/Tdarr/Plugins/Local/`
   - **Windows**: `C:\ProgramData\Tdarr\Plugins\Local\`
   - **Linux**: `/opt/tdarr/Plugins/Local/` or `~/.config/Tdarr/Plugins/Local/`

2. Restart Tdarr or reload plugins

3. The plugin will automatically install its dependencies (`sync-request`)

## Configuration

### Plugin Inputs

#### Radarr Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `radarr_enabled` | Boolean | `true` | Enable Radarr processing |
| `radarr_path_contains` | String | `/movies/` | Path must contain this string to trigger Radarr |
| `radarr_host` | String | `http://localhost:7878` | Full URL to your Radarr instance |
| `radarr_api_key` | String | *(empty)* | API Key for Radarr — prefer the env var or credentials file (see below) so the key stays out of Tdarr's logs |

#### Sonarr Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sonarr_enabled` | Boolean | `true` | Enable Sonarr processing |
| `sonarr_path_contains` | String | `/tv/` | Path must contain this string to trigger Sonarr |
| `sonarr_host` | String | `http://localhost:8989` | Full URL to your Sonarr instance |
| `sonarr_api_key` | String | *(empty)* | API Key for Sonarr — prefer the env var or credentials file (see below) so the key stays out of Tdarr's logs |

#### Shared Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `refresh_first` | Boolean | `true` | Trigger a disk rescan before renaming to ensure the new file is detected |
| `rescan_wait_seconds` | Number | `15` | Max seconds to wait for the rescan before deferring the rename to the next run (`0` = never wait) |

### API Keys Without Leaking Them Into Logs

Tdarr dumps **all plugin inputs** into the worker log on every run — so an API key set
as a plugin input ends up in plain text in your logs. To avoid that, leave the
`*_api_key` inputs empty and provide the keys one of these ways instead
(resolution order: input → env var → credentials file):

1. **Environment variables** on the Tdarr node/container: `RADARR_API_KEY` and `SONARR_API_KEY`
2. **Credentials file** — `arr_credentials.json` next to the plugin, or at `/app/configs/arr_credentials.json` (Docker):

```json
{
  "radarr_api_key": "your_radarr_api_key",
  "sonarr_api_key": "your_sonarr_api_key"
}
```

Restrict the file's permissions (e.g. `chmod 600`).

## Usage

### In Tdarr Flow

1. Add the plugin to your Tdarr Flow using the **Classic Plugin** node (`runClassicTranscodePlugin`)
2. Select `Tdarr_Plugin_rovey_arr_rename_trigger` from the plugin dropdown
3. Configure the plugin settings:
   - Set your Radarr/Sonarr host URLs
   - Add your API keys
   - Configure path matching strings (e.g., `/movies/`, `/tv/`, `/media/films/`)
4. Enable/disable Radarr or Sonarr based on your needs

> **Note:** This is a **Classic Plugin** with Stage: `Post-processing`. In Tdarr Flows, use the `runClassicTranscodePlugin` node to execute it after your transcode operations.

### Example Configurations

#### Separate Movie and TV Libraries

```
Radarr:
  - Enabled: true
  - Path Contains: /movies/
  - Host: http://192.168.1.100:7878
  - API Key: your_radarr_api_key

Sonarr:
  - Enabled: true
  - Path Contains: /tv/
  - Host: http://192.168.1.100:8989
  - API Key: your_sonarr_api_key
```

#### Only Movies (Sonarr Disabled)

```
Radarr:
  - Enabled: true
  - Path Contains: /media/
  - Host: http://localhost:7878
  - API Key: your_radarr_api_key

Sonarr:
  - Enabled: false
```

#### Custom Paths

```
Radarr:
  - Enabled: true
  - Path Contains: /mnt/storage/films/
  
Sonarr:
  - Enabled: true
  - Path Contains: /mnt/storage/series/
```

## How It Works

### Processing Flow

1. **Path Detection**: Checks if file path contains configured strings
2. **Service Selection**: Enables Radarr/Sonarr based on path matching
3. **File Lookup**:
   - **Primary**: Matches the file path against the movie/series folder path (no per-series API calls)
   - **Fallback**: Filters the same already-fetched library client-side by IMDB/TMDB/TVDB ID extracted from the path (Radarr's `?imdbId=` query param is silently ignored, so server-side filtering is unreliable)
4. **Catch-Up Rename**: Renames left pending by earlier runs are fired immediately (fire-and-forget)
5. **Rescan** (optional): Triggers a disk-only rescan (`RescanMovie`/`RescanSeries`) and polls `GET /api/v3/command/{id}` for at most `rescan_wait_seconds`
6. **Rename**: If the rescan finished in time and a rename is pending, fires the rename without waiting for it; otherwise the rename is picked up by the next run (step 4)

### ID Detection

The plugin automatically extracts IDs from file paths:

- **IMDB**: `tt1234567` → `{imdb-tt1234567}`
- **TMDB**: `tmdb-12345` or `tmdbid-12345` → `{tmdb-12345}`
- **TVDB**: `tvdb-12345` or `tvdbid-12345` → `{tvdb-12345}`

### API Commands Used

**Radarr (v3 API):**
- `GET /api/v3/movie` — List all movies (path + ID matching)
- `GET /api/v3/rename?movieId={id}` — Probe pending renames
- `POST /api/v3/command` with `RescanMovie` — Disk-only rescan
- `GET /api/v3/command/{id}` — Poll rescan status (bounded by `rescan_wait_seconds`)
- `POST /api/v3/command` with `RenameMovie` — Trigger file rename (fire-and-forget)

**Sonarr (v3 API):**
- `GET /api/v3/series` — List all series (folder-path + ID matching)
- `GET /api/v3/rename?seriesId={id}` — Probe pending renames
- `POST /api/v3/command` with `RescanSeries` — Disk-only rescan
- `GET /api/v3/command/{id}` — Poll rescan status (bounded by `rescan_wait_seconds`)
- `POST /api/v3/command` with `RenameSeries` — Trigger file rename (fire-and-forget)

## Example Log Output

### Successful Radarr Rename

```
[RenameTrigger] Path: /data/media/movies/K3 The Ice Princess (2006) {imdb-tt0812265}/K3 The Ice Princess (2006).mkv
[RenameTrigger] Path contains '/movies/' → Using Radarr
[RenameTrigger] Detected IDs → imdb:tt0812265 tmdb:- tvdb:-
[RenameTrigger] Processing with Radarr at http://172.28.10.12:7878
[RenameTrigger] Looking up movie by file path...
[RenameTrigger] Found movie by file path: K3 The Ice Princess (id=42)
[RenameTrigger] Using movie: K3 The Ice Princess (id=42)
[RenameTrigger] Triggering RescanMovie...
[RenameTrigger] RescanMovie finished with status: completed
[RenameTrigger] RenameMovie fired (201)
```

### No-op (file already correctly named)

```
[RenameTrigger] Triggering RefreshMovie...
[RenameTrigger] RefreshMovie response: 201
[RenameTrigger] Waiting for RefreshMovie (id=1724120) to finish before renaming...
[RenameTrigger] RefreshMovie finished with status: completed
[RenameTrigger] Pending renames after refresh: 0
[RenameTrigger] ✓ No rename needed — skipping RenameMovie.
```

### Successful Sonarr Rename

```
[RenameTrigger] Path: /data/media/tv/Invincible (2021) {imdb-tt6741278}/Season 01/Invincible (2021) - S01E05.mkv
[RenameTrigger] Path contains '/tv/' → Using Sonarr
[RenameTrigger] Detected IDs → imdb:tt6741278 tmdb:- tvdb:-
[RenameTrigger] Processing with Sonarr at http://172.28.10.4:8989
[RenameTrigger] Looking up series by episode file path...
[RenameTrigger] Matched series folder: Invincible (id=23)
[RenameTrigger] Using series: Invincible (id=23)
[RenameTrigger] Triggering RescanSeries...
[RenameTrigger] RescanSeries finished with status: completed
[RenameTrigger] RenameSeries fired (201)
```

## Requirements

- **Tdarr**: v2.x or later
- **Radarr**: v3 API (Radarr v3.0.0+)
- **Sonarr**: v3 API (Sonarr v3.0.0+)
- **Node.js**: v14+ (bundled with Tdarr)

## Troubleshooting

### Plugin Not Triggering

- Check that path contains the configured string (case-insensitive)
- Verify service is enabled in plugin settings
- Check Tdarr logs for path detection messages

### Movie/Series Not Found

- Ensure file path exactly matches the path in Radarr/Sonarr
- Verify IMDB/TMDB/TVDB ID is correctly formatted in path
- Check that movie/series exists in Radarr/Sonarr
- Review plugin logs for detailed error messages

### API Errors

- Verify host URL is accessible from Tdarr container/server
- Check API key is correct and has proper permissions
- Ensure Radarr/Sonarr v3 API is being used (not v1/v2)
- Check Radarr/Sonarr logs for API request errors

### Files Not Actually Renamed

- Enable `refresh_first` option (the plugin needs it to update mediainfo before checking for a rename)
- Confirm the plugin log contains `RefreshMovie finished with status: completed` and `Pending renames after refresh: N` — if the refresh times out (60 s), open Radarr's System → Tasks page and look for a stuck queue
- If `Pending renames after refresh: 0` appears, Radarr genuinely doesn't see anything to rename — check your naming scheme in Radarr/Sonarr settings against the actual filename
- Manually call `GET /api/v3/rename?movieId=...` (or `?seriesId=...`) to confirm what Radarr/Sonarr think is pending

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Author

**Rovey**

## Acknowledgments

- Built for use with [Tdarr](https://tdarr.io/)
- Integrates with [Radarr](https://radarr.video/) and [Sonarr](https://sonarr.tv/)
- Uses [sync-request](https://www.npmjs.com/package/sync-request) for synchronous HTTP calls

## Version History

### 1.5.0 (2026-07-28)
- API keys resolvable via env vars (`RADARR_API_KEY`/`SONARR_API_KEY`) or `arr_credentials.json`, keeping them out of Tdarr's worker logs

### 1.4.0 (2026-07-27)
- Non-blocking: renames fire-and-forget, rescan wait capped by `rescan_wait_seconds` (default 15s); deferred renames are caught up on the next run

### 1.3.0 (2026-07-27)
- Series lookup via folder-path prefix match instead of up to ~90 sequential episodefile calls
- `RefreshMovie`/`RefreshSeries` replaced by disk-only `RescanMovie`/`RescanSeries` (no metadata-provider hit)
- Based on the 1.2.0 codebase; the internal 1.2.1 refactor was not carried forward

### 1.2.1 (2026-07-02)
- Fix: the "✓ rename command sent successfully" line is now only logged when the rename command actually completes; previously it was still printed after a failed or timed-out rename.
- Refactor: the Radarr and Sonarr branches share one refresh → probe → rename flow via internal helpers instead of two near-identical copies. API calls and log output are unchanged.

### 1.2.0 (2026-05-05)
- Fix the silent IMDB/TMDB/TVDB fallback bug: Radarr's `GET /api/v3/movie?imdbId=` is ignored server-side and returns the full library, so the previous code grabbed `[0]` (the alphabetically-first movie) instead of the requested title. Lookup now filters the already-fetched library client-side; same fix applied to the Sonarr fallback.
- Add idempotent skip: probe `GET /api/v3/rename?movieId=...` (or `?seriesId=...`) after the refresh completes, and skip the `RenameMovie`/`RenameSeries` API call entirely when nothing is pending.
- Wait for the rename command to complete (poll `GET /api/v3/command/{id}`) before logging success, so the plugin's "✓ rename command sent successfully" message reflects actual completion rather than just queueing.

### 1.1.0 (2026-05-05)
- Fix race condition where Tdarr's post-transcode rename trigger left files with stale codec tags in the filename. The previous fire-and-forget pattern queued `RefreshMovie` and `RenameMovie` back-to-back; Radarr's command worker could execute the rename before the refresh's disk rescan + mediainfo update completed, so the rename evaluator compared the new filename against stale DB metadata, found it "matched", and skipped the rename. The plugin now polls `GET /api/v3/command/{id}` once per second (60 s timeout) until the refresh reaches `completed`/`failed`/`aborted` before triggering the rename. Same change applied to the Sonarr branch.
- Sleep between polls uses `Atomics.wait` rather than busy-waiting, so polling does not pin a CPU core.

### 1.0.0 (2025-10-09)
- Initial release
- Path-based Radarr/Sonarr detection
- File path lookup with ID fallback
- Support for IMDB, TMDB, and TVDB IDs
- Independent enable/disable toggles
- Configurable path matching
- Optional refresh before rename
