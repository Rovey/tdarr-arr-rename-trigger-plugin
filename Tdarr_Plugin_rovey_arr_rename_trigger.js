// List any npm dependencies which the plugin needs, they will be auto installed when the plugin runs:
module.exports.dependencies = [
    'sync-request',
];

const details = () => ({
    id: 'Tdarr_Plugin_rovey_arr_rename_trigger',
    Stage: 'Post-processing',
    Name: 'Trigger Radarr/Sonarr Rename',
    Type: 'Video',
    Operation: 'Transcode',
    Description: `
    Triggers Radarr or Sonarr to Refresh and Rename the file after transcoding.
    Automatically detects whether to use Radarr or Sonarr based on file metadata.
    `,
    Version: '1.5.0',
    Tags: 'post-processing,3rd party,radarr,sonarr',
    Inputs: [
        {
            name: 'radarr_enabled',
            type: 'boolean',
            defaultValue: true,
            inputUI: {
                type: 'dropdown',
                options: [
                    'true',
                    'false',
                ],
            },
            tooltip: 'Enable Radarr processing',
        },
        {
            name: 'radarr_path_contains',
            type: 'string',
            defaultValue: '/movies/',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Path must contain this string to trigger Radarr (e.g., /movies/ or /media/movies/)',
        },
        {
            name: 'radarr_host',
            type: 'string',
            defaultValue: 'http://localhost:7878',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Full URL to your Radarr instance (e.g., http://localhost:7878)',
        },
        {
            name: 'radarr_api_key',
            type: 'string',
            defaultValue: '',
            inputUI: {
                type: 'text',
            },
            tooltip: 'API Key for Radarr. Prefer leaving this EMPTY and providing the key via the RADARR_API_KEY env var or an arr_credentials.json file instead — Tdarr dumps all plugin inputs into the worker log, so a key set here ends up in plain text in the logs.',
        },
        {
            name: 'sonarr_enabled',
            type: 'boolean',
            defaultValue: true,
            inputUI: {
                type: 'dropdown',
                options: [
                    'true',
                    'false',
                ],
            },
            tooltip: 'Enable Sonarr processing',
        },
        {
            name: 'sonarr_path_contains',
            type: 'string',
            defaultValue: '/tv/',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Path must contain this string to trigger Sonarr (e.g., /series/ or /media/tv/)',
        },
        {
            name: 'sonarr_host',
            type: 'string',
            defaultValue: 'http://localhost:8989',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Full URL to your Sonarr instance (e.g., http://localhost:8989)',
        },
        {
            name: 'sonarr_api_key',
            type: 'string',
            defaultValue: '',
            inputUI: {
                type: 'text',
            },
            tooltip: 'API Key for Sonarr. Prefer leaving this EMPTY and providing the key via the SONARR_API_KEY env var or an arr_credentials.json file instead — Tdarr dumps all plugin inputs into the worker log, so a key set here ends up in plain text in the logs.',
        },
        {
            name: 'refresh_first',
            type: 'boolean',
            defaultValue: true,
            inputUI: {
                type: 'dropdown',
                options: [
                    'true',
                    'false',
                ],
            },
            tooltip: 'Trigger a refresh before renaming to ensure the new file is detected',
        },
        {
            name: 'rescan_wait_seconds',
            type: 'number',
            defaultValue: 15,
            inputUI: {
                type: 'text',
            },
            tooltip: 'Max seconds to wait for the rescan before deferring the rename to the next run (0 = never wait). Keeps the Tdarr worker from blocking on big-series rescans.',
        },
    ],
});

// Tdarr's classic plugin API is synchronous: plugin() has to return the finished
// response object, so every wait below blocks the worker thread on purpose.
const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// Trailing slashes would double up once an /api/v3 path is appended.
const normalizeHost = (value) => (value || '').replace(/\/+$/, '');

// *arr IDs travel in the file path, e.g. "Example (2020) [imdb-tt1375666]".
const extractIds = (path) => ({
    imdb: (path.match(/tt\d+/i) || [])[0],
    tmdb: (path.match(/(?:tmdb|tmdbid)[-_]?(\d{3,})/i) || [])[1],
    tvdb: (path.match(/(?:tvdb|tvdbid)[-_]?(\d{3,})/i) || [])[1],
});

const readCredentialsFile = (log) => {
    try {
        // Required lazily so a host without these modules only fails when the
        // file lookup is actually reached.
        const fs = require('fs');
        const nodePath = require('path');
        const candidates = [
            nodePath.join(__dirname, 'arr_credentials.json'),
            '/app/configs/arr_credentials.json',
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return JSON.parse(fs.readFileSync(candidate, 'utf8'));
            }
        }
    } catch (e) {
        log(`[RenameTrigger] Could not read credentials file: ${e.message}\n`);
    }
    return {};
};

// API keys: prefer env vars or a credentials file over plugin inputs — Tdarr
// dumps all plugin inputs into the worker log, so keys passed as inputs end
// up in plain text there. Resolution order: input (legacy) > env > file.
const createApiKeyResolver = (log) => {
    let credentials = null;
    return (inputValue, envName, fileField) => {
        const fromInput = (inputValue || '').toString().trim();
        if (fromInput) return fromInput;
        if (process.env[envName] && process.env[envName].trim()) return process.env[envName].trim();
        if (credentials === null) credentials = readCredentialsFile(log);
        return (credentials[fileField] || '').toString().trim();
    };
};

// Poll a queued *arr command until it finishes (or timeout). Without this,
// RenameMovie/RenameSeries races the Refresh's mediainfo rescan and skips the rename.
const waitForCommand = (request, log, host, apiKey, commandId, label, timeoutMs) => {
    const waitMs = timeoutMs || 60000;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        try {
            const res = request('GET', `${host}/api/v3/command/${commandId}`, {
                headers: { 'X-Api-Key': apiKey },
                timeout: 10000,
            });
            const cmd = JSON.parse(res.getBody('utf8'));
            const status = (cmd.status || '').toLowerCase();
            if (status === 'completed' || status === 'failed' || status === 'aborted') {
                log(`[RenameTrigger] ${label} finished with status: ${status}\n`);
                return status === 'completed';
            }
        } catch (e) {
            log(`[RenameTrigger] ${label} poll error: ${e.message}\n`);
            return false;
        }
        sleepSync(1000);
    }
    log(`[RenameTrigger] ${label} still running after ${Math.round(waitMs / 1000)}s\n`);
    return false;
};

// eslint-disable-next-line no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {
    const lib = require('../methods/lib')();
    // eslint-disable-next-line no-unused-vars,no-param-reassign
    inputs = lib.loadDefaultValues(inputs, details);

    const response = {
        processFile: false,
        preset: '',
        container: '.mkv',
        handBrakeMode: false,
        FFmpegMode: false,
        reQueueAfter: false,
        infoLog: '',
    };

    const request = require('sync-request');
    const log = (line) => {
        response.infoLog += line;
    };

    const resolveApiKey = createApiKeyResolver(log);

    const radarrEnabled = inputs.radarr_enabled === true;
    const radarrPathContains = (inputs.radarr_path_contains || '').trim();
    const radarrHost = normalizeHost(inputs.radarr_host);
    const radarrApiKey = resolveApiKey(inputs.radarr_api_key, 'RADARR_API_KEY', 'radarr_api_key');

    const sonarrEnabled = inputs.sonarr_enabled === true;
    const sonarrPathContains = (inputs.sonarr_path_contains || '').trim();
    const sonarrHost = normalizeHost(inputs.sonarr_host);
    const sonarrApiKey = resolveApiKey(inputs.sonarr_api_key, 'SONARR_API_KEY', 'sonarr_api_key');

    const refreshFirst = inputs.refresh_first === true;
    const rescanWaitMs = Math.max(0, parseInt(inputs.rescan_wait_seconds, 10) || 0) * 1000;

    const path = file.file || file._id || '';
    if (!path) {
        log('[RenameTrigger] File path missing from Tdarr context.\n');
        return response;
    }

    log(`[RenameTrigger] Path: ${path}\n`);

    // Determine which service to use based on path matching
    let useRadarr = false;
    let useSonarr = false;

    if (radarrEnabled && radarrPathContains && path.toLowerCase().includes(radarrPathContains.toLowerCase())) {
        useRadarr = true;
        log(`[RenameTrigger] Path contains '${radarrPathContains}' → Using Radarr\n`);
    }

    if (sonarrEnabled && sonarrPathContains && path.toLowerCase().includes(sonarrPathContains.toLowerCase())) {
        useSonarr = true;
        log(`[RenameTrigger] Path contains '${sonarrPathContains}' → Using Sonarr\n`);
    }

    if (!useRadarr && !useSonarr) {
        log('[RenameTrigger] Path does not match any enabled service. Skipping.\n');
        log(`[RenameTrigger] Radarr enabled: ${radarrEnabled}, path check: '${radarrPathContains}'\n`);
        log(`[RenameTrigger] Sonarr enabled: ${sonarrEnabled}, path check: '${sonarrPathContains}'\n`);
        return response;
    }

    const ids = extractIds(path);

    log(`[RenameTrigger] Detected IDs → imdb:${ids.imdb || '-'} tmdb:${ids.tmdb || '-'} tvdb:${ids.tvdb || '-'}\n`);

    try {
        // Process Radarr if enabled and path matches
        if (useRadarr) {
            if (!radarrHost || !radarrApiKey) {
                log('[RenameTrigger] Radarr: Missing host or API key.\n');
            } else {
                log(`[RenameTrigger] Processing with Radarr at ${radarrHost}\n`);

                // First, try to find the movie by file path
                log('[RenameTrigger] Looking up movie by file path...\n');

                const allMoviesRes = request('GET', `${radarrHost}/api/v3/movie`, {
                    headers: { 'X-Api-Key': radarrApiKey },
                    timeout: 15000,
                });

                const allMovies = JSON.parse(allMoviesRes.getBody('utf8'));
                let movie = null;

                // Find movie where the file path matches
                for (const m of allMovies) {
                    if (m.movieFile && m.movieFile.path === path) {
                        movie = m;
                        log(`[RenameTrigger] Found movie by file path: ${movie.title} (id=${movie.id})\n`);
                        break;
                    }
                }

                // Fallback: filter the already-fetched movie list client-side. Radarr's
                // GET /api/v3/movie ignores ?imdbId= and silently returns all movies, so
                // taking [0] grabs the wrong title alphabetically.
                if (!movie && (ids.imdb || ids.tmdb)) {
                    log('[RenameTrigger] File not found by path, trying ID match against movie list...\n');
                    if (ids.imdb) {
                        movie = allMovies.find((m) => m.imdbId === ids.imdb) || null;
                    }
                    if (!movie && ids.tmdb) {
                        const tmdbNum = parseInt(ids.tmdb, 10);
                        movie = allMovies.find((m) => m.tmdbId === tmdbNum) || null;
                    }
                    if (movie) {
                        log(`[RenameTrigger] Found movie by ID: ${movie.title} (id=${movie.id})\n`);
                    }
                } else if (!movie) {
                    log('[RenameTrigger] No imdb/tmdb ID found and file not in Radarr.\n');
                }

                if (!movie || !movie.id) {
                    log('[RenameTrigger] Radarr: movie not found in Radarr.\n');
                } else {
                    const movieId = movie.id;
                    log(`[RenameTrigger] Using movie: ${movie.title} (id=${movieId})\n`);

                    // Renames are fire-and-forget: Radarr finishes them on its own,
                    // so blocking the Tdarr worker on them adds nothing.
                    const probeRadarrRenames = () => {
                        try {
                            const probeRes = request('GET', `${radarrHost}/api/v3/rename?movieId=${movieId}`, {
                                headers: { 'X-Api-Key': radarrApiKey },
                                timeout: 10000,
                            });
                            const pending = JSON.parse(probeRes.getBody('utf8'));
                            return Array.isArray(pending) ? pending.length : 0;
                        } catch (e) {
                            log(`[RenameTrigger] Rename probe failed: ${e.message}\n`);
                            return 0;
                        }
                    };
                    const fireRadarrRename = () => {
                        const renameRes = request('POST', `${radarrHost}/api/v3/command`, {
                            headers: {
                                'X-Api-Key': radarrApiKey,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                name: 'RenameMovie',
                                movieIds: [movieId],
                            }),
                            timeout: 10000,
                        });
                        log(`[RenameTrigger] RenameMovie fired (${renameRes.statusCode})\n`);
                    };

                    // Renames left pending by earlier runs can go out right away.
                    if (probeRadarrRenames() > 0) {
                        fireRadarrRename();
                    }

                    if (refreshFirst) {
                        // RescanMovie only re-reads the file from disk; RefreshMovie also
                        // hits the metadata provider, which the rename doesn't need.
                        log('[RenameTrigger] Triggering RescanMovie...\n');
                        const rescanRes = request('POST', `${radarrHost}/api/v3/command`, {
                            headers: {
                                'X-Api-Key': radarrApiKey,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                name: 'RescanMovie',
                                movieId: movieId,
                            }),
                            timeout: 10000,
                        });
                        try {
                            const rescanCmd = JSON.parse(rescanRes.getBody('utf8'));
                            if (rescanCmd && rescanCmd.id && rescanWaitMs > 0
                                && waitForCommand(request, log, radarrHost, radarrApiKey, rescanCmd.id, 'RescanMovie', rescanWaitMs)) {
                                if (probeRadarrRenames() > 0) {
                                    fireRadarrRename();
                                } else {
                                    log('[RenameTrigger] ✓ No rename needed.\n');
                                }
                            } else {
                                log('[RenameTrigger] Rescan still busy — rename deferred to a later run.\n');
                            }
                        } catch (e) {
                            log(`[RenameTrigger] Could not parse RescanMovie response: ${e.message}\n`);
                        }
                    }
                }
            }
        }

        // Process Sonarr if enabled and path matches
        if (useSonarr) {
            if (!sonarrHost || !sonarrApiKey) {
                log('[RenameTrigger] Sonarr: Missing host or API key.\n');
            } else {
                log(`[RenameTrigger] Processing with Sonarr at ${sonarrHost}\n`);

                // First, try to find the series by episode file path
                log('[RenameTrigger] Looking up series by episode file path...\n');

                const allSeriesRes = request('GET', `${sonarrHost}/api/v3/series`, {
                    headers: { 'X-Api-Key': sonarrApiKey },
                    timeout: 15000,
                });

                const allSeries = JSON.parse(allSeriesRes.getBody('utf8'));
                let show = null;

                // The episode path always lives under the series' root folder, so a
                // prefix match on series.path finds the show without the per-series
                // episodefile calls (up to ~90 sequential requests) this used to do.
                for (const s of allSeries) {
                    if (!s.path) continue;
                    const folder = s.path.endsWith('/') ? s.path : `${s.path}/`;
                    if (path.startsWith(folder)) {
                        show = s;
                        log(`[RenameTrigger] Matched series folder: ${show.title} (id=${show.id})\n`);
                        break;
                    }
                }

                // Fallback: filter the already-fetched series list client-side. Sonarr's
                // GET /api/v3/series only honors tvdbId reliably; imdbId/tmdbId can return
                // an unfiltered list, making [0] the wrong show.
                if (!show && (ids.tvdb || ids.imdb || ids.tmdb)) {
                    log('[RenameTrigger] File not found by path, trying ID match against series list...\n');
                    if (ids.tvdb) {
                        const tvdbNum = parseInt(ids.tvdb, 10);
                        show = allSeries.find((s) => s.tvdbId === tvdbNum) || null;
                    }
                    if (!show && ids.imdb) {
                        show = allSeries.find((s) => s.imdbId === ids.imdb) || null;
                    }
                    if (!show && ids.tmdb) {
                        const tmdbNum = parseInt(ids.tmdb, 10);
                        show = allSeries.find((s) => s.tmdbId === tmdbNum) || null;
                    }
                    if (show) {
                        log(`[RenameTrigger] Found series by ID: ${show.title} (id=${show.id})\n`);
                    }
                } else if (!show) {
                    log('[RenameTrigger] No tvdb/tmdb/imdb ID found and file not in Sonarr.\n');
                }

                if (!show || !show.id) {
                    log('[RenameTrigger] Sonarr: series not found in Sonarr.\n');
                } else {
                    const seriesId = show.id;
                    log(`[RenameTrigger] Using series: ${show.title} (id=${seriesId})\n`);

                    // Renames are fire-and-forget: Sonarr finishes them on its own,
                    // so blocking the Tdarr worker on them adds nothing.
                    const probeSonarrRenames = () => {
                        try {
                            const probeRes = request('GET', `${sonarrHost}/api/v3/rename?seriesId=${seriesId}`, {
                                headers: { 'X-Api-Key': sonarrApiKey },
                                timeout: 10000,
                            });
                            const pending = JSON.parse(probeRes.getBody('utf8'));
                            return Array.isArray(pending) ? pending.length : 0;
                        } catch (e) {
                            log(`[RenameTrigger] Rename probe failed: ${e.message}\n`);
                            return 0;
                        }
                    };
                    const fireSonarrRename = () => {
                        const renameRes = request('POST', `${sonarrHost}/api/v3/command`, {
                            headers: {
                                'X-Api-Key': sonarrApiKey,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                name: 'RenameSeries',
                                seriesIds: [seriesId],
                            }),
                            timeout: 10000,
                        });
                        log(`[RenameTrigger] RenameSeries fired (${renameRes.statusCode})\n`);
                    };

                    // Renames left pending by earlier runs (e.g. rescans that outlived
                    // the wait window) can go out right away.
                    if (probeSonarrRenames() > 0) {
                        fireSonarrRename();
                    }

                    if (refreshFirst) {
                        // RescanSeries only re-reads files on disk; RefreshSeries also
                        // refreshes metadata from SkyHook, which the rename doesn't need.
                        log('[RenameTrigger] Triggering RescanSeries...\n');
                        const rescanRes = request('POST', `${sonarrHost}/api/v3/command`, {
                            headers: {
                                'X-Api-Key': sonarrApiKey,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                name: 'RescanSeries',
                                seriesId: seriesId,
                            }),
                            timeout: 10000,
                        });
                        try {
                            const rescanCmd = JSON.parse(rescanRes.getBody('utf8'));
                            if (rescanCmd && rescanCmd.id && rescanWaitMs > 0
                                && waitForCommand(request, log, sonarrHost, sonarrApiKey, rescanCmd.id, 'RescanSeries', rescanWaitMs)) {
                                if (probeSonarrRenames() > 0) {
                                    fireSonarrRename();
                                } else {
                                    log('[RenameTrigger] ✓ No rename needed.\n');
                                }
                            } else {
                                log('[RenameTrigger] Rescan still busy — rename deferred to a later run.\n');
                            }
                        } catch (e) {
                            log(`[RenameTrigger] Could not parse RescanSeries response: ${e.message}\n`);
                        }
                    }
                }
            }
        }
    } catch (err) {
        log(`[RenameTrigger] ✗ Error: ${err.message}\n`);
    }

    return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
