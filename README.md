# Tdarr Radarr/Sonarr Rename Trigger Plugin

A Tdarr post-processing plugin that automatically triggers Radarr or Sonarr to rename media files after transcoding is complete.

## Features

- Triggers Radarr (movies) and Sonarr (TV series) to rename files after Tdarr finishes transcoding
- Path-based detection with independent enable/disable and path filters per service
- Instant lookup via folder-path matching, with IMDB/TMDB/TVDB ID fallback (filtered client-side against the full library, since Radarr silently ignores ID query parameters)
- Optional disk-only rescan before renaming (no metadata provider hit) so the new file is detected
- Non-blocking: renames are fire-and-forget, rescans wait at most a configurable number of seconds, and deferred renames are caught up on the next run
- API keys can be provided via environment variables or a credentials file, keeping them out of Tdarr's worker logs
- Detailed logging for debugging and monitoring

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
| `rescan_wait_seconds` | String | `15` | Max seconds to wait for the rescan before deferring the rename to the next run (`0` = never wait; anything that is not a whole number of seconds falls back to `15`). It is a text field in Tdarr either way — the input is declared as a string so Tdarr cannot turn a typo into `0`, which would silently mean "never wait" |

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
   - Provide your API keys — preferably via env vars or the credentials file (see [API Keys Without Leaking Them Into Logs](#api-keys-without-leaking-them-into-logs)), not as plugin inputs
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
  - API Key: (empty — provided via env var or credentials file)

Sonarr:
  - Enabled: true
  - Path Contains: /tv/
  - Host: http://192.168.1.100:8989
  - API Key: (empty — provided via env var or credentials file)
```

#### Only Movies (Sonarr Disabled)

```
Radarr:
  - Enabled: true
  - Path Contains: /media/
  - Host: http://localhost:7878
  - API Key: (empty — provided via env var or credentials file)

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
[RenameTrigger] Triggering RescanMovie...
[RenameTrigger] RescanMovie finished with status: completed
[RenameTrigger] ✓ No rename needed.
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

## Development

The repository contains a test suite for the plugin. Run it from the repository root:

```bash
npm test
```

This uses Node's built-in test runner (`node --test`), so it needs Node 18+ but no `npm install`
and no network access: `sync-request`, Tdarr's `../methods/lib` and the credentials-file lookup are
mocked for the duration of each test. The tests live in `tests/`.

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
- Confirm the plugin log contains `RescanMovie finished with status: completed` (or `RescanSeries ...`). If you see `Rescan still busy — rename deferred to a later run.` instead, the rescan outlived `rescan_wait_seconds` — the rename is caught up automatically on the next plugin run for that movie/series, or you can raise `rescan_wait_seconds`
- If you see `Not waiting for the rescan (rescan_wait_seconds = 0) — rename deferred to a later run.`, the wait is switched off, so every rename is handled by the *next* run for that movie/series. Set `rescan_wait_seconds` back to `15` (or higher) to have the rename fired in the same run
- If the log shows `✓ No rename needed.`, Radarr/Sonarr genuinely doesn't see anything to rename — check your naming scheme in Radarr/Sonarr settings against the actual filename
- Manually call `GET /api/v3/rename?movieId=...` (or `?seriesId=...`) to confirm what Radarr/Sonarr think is pending
- Rescans that never finish usually mean a jammed command queue — check System → Tasks in Radarr/Sonarr

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

The full release history is kept in [CHANGELOG.md](CHANGELOG.md).
