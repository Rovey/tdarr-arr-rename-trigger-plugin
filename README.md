# Tdarr Radarr/Sonarr Rename Trigger Plugin

A Tdarr post-processing plugin that automatically triggers Radarr or Sonarr to rename media files after transcoding is complete.

## Features

- 🎬 **Radarr Support**: Automatically rename movies after transcoding
- 📺 **Sonarr Support**: Automatically rename TV series episodes after transcoding
- 🔍 **Smart Detection**: Path-based detection with configurable path matching
- 🎯 **Accurate Lookup**: Primary lookup by exact file path, fallback to IMDB/TMDB/TVDB IDs (client-side filtered against the full library to avoid Radarr's ignored-query-param footgun)
- ⚙️ **Flexible Configuration**: Enable/disable services independently with custom path filters
- 🔄 **Synchronous Refresh + Rename**: Polls the Radarr/Sonarr command queue until `RefreshMovie`/`RefreshSeries` actually completes before triggering rename — eliminates the race that left files with stale codec tags after a transcode
- ⚡ **No-op Skip**: Probes the rename-preview endpoint after refresh and skips the rename API call when nothing is pending
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
| `radarr_api_key` | String | *(empty)* | API Key for Radarr |

#### Sonarr Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sonarr_enabled` | Boolean | `true` | Enable Sonarr processing |
| `sonarr_path_contains` | String | `/tv/` | Path must contain this string to trigger Sonarr |
| `sonarr_host` | String | `http://localhost:8989` | Full URL to your Sonarr instance |
| `sonarr_api_key` | String | *(empty)* | API Key for Sonarr |

#### Shared Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `refresh_first` | Boolean | `true` | Trigger refresh before renaming to ensure new file is detected |

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
   - **Primary**: Searches for exact file path match against the full Radarr/Sonarr library
   - **Fallback**: Filters the same already-fetched library client-side by IMDB/TMDB/TVDB ID extracted from the path (Radarr's `?imdbId=` query param is silently ignored, so server-side filtering is unreliable)
4. **Refresh** (optional): Fires `RefreshMovie`/`RefreshSeries` and **polls `GET /api/v3/command/{id}` once per second** (60 s timeout) until the command reaches `completed`/`failed`/`aborted`. This guarantees the disk rescan + mediainfo update has finished before the rename runs.
5. **Rename Probe**: Calls `GET /api/v3/rename?movieId=...` (or `?seriesId=...`). If the response is `[]`, skips the rename API call entirely.
6. **Rename**: Fires `RenameMovie`/`RenameSeries` and waits for that command to complete the same way, so the plugin's success log reflects actual completion, not just queueing.

### ID Detection

The plugin automatically extracts IDs from file paths:

- **IMDB**: `tt1234567` → `{imdb-tt1234567}`
- **TMDB**: `tmdb-12345` or `tmdbid-12345` → `{tmdb-12345}`
- **TVDB**: `tvdb-12345` or `tvdbid-12345` → `{tvdb-12345}`

### API Commands Used

**Radarr (v3 API):**
- `GET /api/v3/movie` — List all movies (used for both file-path and IMDB/TMDB matching)
- `POST /api/v3/command` with `RefreshMovie` — Refresh movie metadata + rescan disk
- `GET /api/v3/command/{id}` — Poll command status until completion
- `GET /api/v3/rename?movieId={id}` — Probe whether any rename is pending
- `POST /api/v3/command` with `RenameMovie` — Trigger file rename

**Sonarr (v3 API):**
- `GET /api/v3/series` — List all series
- `GET /api/v3/episodefile?seriesId=X` — Get episode files for series
- `POST /api/v3/command` with `RefreshSeries` — Refresh series metadata + rescan disk
- `GET /api/v3/command/{id}` — Poll command status until completion
- `GET /api/v3/rename?seriesId={id}` — Probe whether any rename is pending
- `POST /api/v3/command` with `RenameSeries` — Trigger file rename

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
[RenameTrigger] Triggering RefreshMovie...
[RenameTrigger] RefreshMovie response: 201
[RenameTrigger] Waiting for RefreshMovie (id=1724118) to finish before renaming...
[RenameTrigger] RefreshMovie finished with status: completed
[RenameTrigger] Pending renames after refresh: 1
[RenameTrigger] Triggering RenameMovie...
[RenameTrigger] RenameMovie response: 201
[RenameTrigger] RenameMovie finished with status: completed
[RenameTrigger] ✓ Radarr rename command sent successfully!
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
[RenameTrigger] Found series by episode file path: Invincible (id=23)
[RenameTrigger] Using series: Invincible (id=23)
[RenameTrigger] Triggering RefreshSeries...
[RenameTrigger] RefreshSeries response: 201
[RenameTrigger] Waiting for RefreshSeries (id=98212) to finish before renaming...
[RenameTrigger] RefreshSeries finished with status: completed
[RenameTrigger] Pending renames after refresh: 1
[RenameTrigger] Triggering RenameSeries...
[RenameTrigger] RenameSeries response: 201
[RenameTrigger] RenameSeries finished with status: completed
[RenameTrigger] ✓ Sonarr rename command sent successfully!
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
