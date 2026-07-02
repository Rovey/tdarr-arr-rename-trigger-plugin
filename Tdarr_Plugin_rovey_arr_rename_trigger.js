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
    Version: '1.2.0',
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
            tooltip: 'API Key for Radarr',
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
            tooltip: 'API Key for Sonarr',
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
    ],
});

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

    const radarrEnabled = inputs.radarr_enabled === true;
    const radarrPathContains = (inputs.radarr_path_contains || '').trim();
    const radarrHost = (inputs.radarr_host || '').replace(/\/+$/, '');
    const radarrApiKey = (inputs.radarr_api_key || '').trim();

    const sonarrEnabled = inputs.sonarr_enabled === true;
    const sonarrPathContains = (inputs.sonarr_path_contains || '').trim();
    const sonarrHost = (inputs.sonarr_host || '').replace(/\/+$/, '');
    const sonarrApiKey = (inputs.sonarr_api_key || '').trim();

    const refreshFirst = inputs.refresh_first === true;

    const COMMAND_WAIT_TIMEOUT_MS = 60000;
    const COMMAND_POLL_INTERVAL_MS = 1000;

    const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
    const sleepSync = (ms) => {
        Atomics.wait(sleepBuf, 0, 0, ms);
    };

    // Poll a queued *arr command until it finishes (or timeout). Without this,
    // RenameMovie/RenameSeries races the Refresh's mediainfo rescan and skips the rename.
    const waitForCommand = (host, apiKey, commandId, label) => {
        const deadline = Date.now() + COMMAND_WAIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            try {
                const res = request('GET', `${host}/api/v3/command/${commandId}`, {
                    headers: { 'X-Api-Key': apiKey },
                    timeout: 10000,
                });
                const cmd = JSON.parse(res.getBody('utf8'));
                const status = (cmd.status || '').toLowerCase();
                if (status === 'completed' || status === 'failed' || status === 'aborted') {
                    response.infoLog += `[RenameTrigger] ${label} finished with status: ${status}\n`;
                    return status === 'completed';
                }
            } catch (e) {
                response.infoLog += `[RenameTrigger] ${label} poll error: ${e.message}\n`;
                return false;
            }
            sleepSync(COMMAND_POLL_INTERVAL_MS);
        }
        response.infoLog += `[RenameTrigger] ${label} timed out after ${COMMAND_WAIT_TIMEOUT_MS / 1000}s\n`;
        return false;
    };

    // POST a *arr command and poll it to completion. announceWait logs the
    // "Waiting for..." line (used for refreshes, where the wait is the point).
    // Returns true only when the command reports status 'completed'.
    const postCommandAndWait = (host, apiKey, body, label, announceWait) => {
        response.infoLog += `[RenameTrigger] Triggering ${label}...\n`;
        const res = request('POST', `${host}/api/v3/command`, {
            headers: {
                'X-Api-Key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            timeout: 10000,
        });
        response.infoLog += `[RenameTrigger] ${label} response: ${res.statusCode}\n`;
        try {
            const cmd = JSON.parse(res.getBody('utf8'));
            if (cmd && cmd.id) {
                if (announceWait) {
                    response.infoLog += `[RenameTrigger] Waiting for ${label} (id=${cmd.id}) to finish before renaming...\n`;
                }
                return waitForCommand(host, apiKey, cmd.id, label);
            }
        } catch (e) {
            response.infoLog += `[RenameTrigger] Could not parse ${label} response: ${e.message}\n`;
        }
        return false;
    };

    // The *arrs' ID query params are unreliable (Radarr ignores ?imdbId= and
    // silently returns all movies, so [0] grabs the wrong title; Sonarr only
    // honors tvdbId) — match the already-fetched library client-side instead.
    // candidates: ordered [field, value, numeric?] triples.
    const findByExternalIds = (list, candidates) => {
        for (const [field, value, numeric] of candidates) {
            if (value) {
                const wanted = numeric ? parseInt(value, 10) : value;
                const match = list.find((item) => item[field] === wanted);
                if (match) return match;
            }
        }
        return null;
    };

    // Shared Radarr/Sonarr flow: refresh (and wait for it), probe pending
    // renames, then rename only if there is actually work to do.
    const refreshProbeAndRename = ({ serviceName, host, apiKey, id, refreshName, renameName, idsKey, probeParam }) => {
        if (refreshFirst) {
            postCommandAndWait(host, apiKey, { name: refreshName, [idsKey]: [id] }, refreshName, true);
        }

        // The probe must run AFTER Refresh so mediainfo is current.
        let renameNeeded = true;
        try {
            const probeRes = request('GET', `${host}/api/v3/rename?${probeParam}=${id}`, {
                headers: { 'X-Api-Key': apiKey },
                timeout: 10000,
            });
            const pending = JSON.parse(probeRes.getBody('utf8'));
            const pendingCount = Array.isArray(pending) ? pending.length : 0;
            renameNeeded = pendingCount > 0;
            response.infoLog += `[RenameTrigger] Pending renames after refresh: ${pendingCount}\n`;
        } catch (e) {
            response.infoLog += `[RenameTrigger] Rename probe failed (${e.message}), will trigger anyway.\n`;
        }

        if (!renameNeeded) {
            response.infoLog += `[RenameTrigger] ✓ No rename needed — skipping ${renameName}.\n`;
        } else if (postCommandAndWait(host, apiKey, { name: renameName, [idsKey]: [id] }, renameName, false)) {
            response.infoLog += `[RenameTrigger] ✓ ${serviceName} rename command sent successfully!\n`;
        }
    };

    const path = file.file || file._id || '';
    if (!path) {
        response.infoLog += '[RenameTrigger] File path missing from Tdarr context.\n';
        return response;
    }

    response.infoLog += `[RenameTrigger] Path: ${path}\n`;

    // Determine which service to use based on path matching
    let useRadarr = false;
    let useSonarr = false;

    if (radarrEnabled && radarrPathContains && path.toLowerCase().includes(radarrPathContains.toLowerCase())) {
        useRadarr = true;
        response.infoLog += `[RenameTrigger] Path contains '${radarrPathContains}' → Using Radarr\n`;
    }

    if (sonarrEnabled && sonarrPathContains && path.toLowerCase().includes(sonarrPathContains.toLowerCase())) {
        useSonarr = true;
        response.infoLog += `[RenameTrigger] Path contains '${sonarrPathContains}' → Using Sonarr\n`;
    }

    if (!useRadarr && !useSonarr) {
        response.infoLog += '[RenameTrigger] Path does not match any enabled service. Skipping.\n';
        response.infoLog += `[RenameTrigger] Radarr enabled: ${radarrEnabled}, path check: '${radarrPathContains}'\n`;
        response.infoLog += `[RenameTrigger] Sonarr enabled: ${sonarrEnabled}, path check: '${sonarrPathContains}'\n`;
        return response;
    }

    const imdb = (path.match(/tt\d+/i) || [])[0];
    const tmdb = (path.match(/(?:tmdb|tmdbid)[-_]?(\d{3,})/i) || [])[1];
    const tvdb = (path.match(/(?:tvdb|tvdbid)[-_]?(\d{3,})/i) || [])[1];

    response.infoLog += `[RenameTrigger] Detected IDs → imdb:${imdb || '-'} tmdb:${tmdb || '-'} tvdb:${tvdb || '-'}\n`;

    try {
        // Process Radarr if enabled and path matches
        if (useRadarr) {
            if (!radarrHost || !radarrApiKey) {
                response.infoLog += '[RenameTrigger] Radarr: Missing host or API key.\n';
            } else {
                response.infoLog += `[RenameTrigger] Processing with Radarr at ${radarrHost}\n`;

                // First, try to find the movie by file path
                response.infoLog += `[RenameTrigger] Looking up movie by file path...\n`;

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
                        response.infoLog += `[RenameTrigger] Found movie by file path: ${movie.title} (id=${movie.id})\n`;
                        break;
                    }
                }

                // Fallback: match by external IDs when the path lookup missed
                if (!movie) {
                    if (imdb || tmdb) {
                        response.infoLog += `[RenameTrigger] File not found by path, trying ID match against movie list...\n`;
                        movie = findByExternalIds(allMovies, [['imdbId', imdb], ['tmdbId', tmdb, true]]);
                        if (movie) {
                            response.infoLog += `[RenameTrigger] Found movie by ID: ${movie.title} (id=${movie.id})\n`;
                        }
                    } else {
                        response.infoLog += '[RenameTrigger] No imdb/tmdb ID found and file not in Radarr.\n';
                    }
                }

                if (!movie || !movie.id) {
                    response.infoLog += '[RenameTrigger] Radarr: movie not found in Radarr.\n';
                } else {
                    response.infoLog += `[RenameTrigger] Using movie: ${movie.title} (id=${movie.id})\n`;
                    refreshProbeAndRename({
                        serviceName: 'Radarr',
                        host: radarrHost,
                        apiKey: radarrApiKey,
                        id: movie.id,
                        refreshName: 'RefreshMovie',
                        renameName: 'RenameMovie',
                        idsKey: 'movieIds',
                        probeParam: 'movieId',
                    });
                }
            }
        }

        // Process Sonarr if enabled and path matches
        if (useSonarr) {
            if (!sonarrHost || !sonarrApiKey) {
                response.infoLog += '[RenameTrigger] Sonarr: Missing host or API key.\n';
            } else {
                response.infoLog += `[RenameTrigger] Processing with Sonarr at ${sonarrHost}\n`;

                // First, try to find the series by episode file path
                response.infoLog += `[RenameTrigger] Looking up series by episode file path...\n`;

                const allSeriesRes = request('GET', `${sonarrHost}/api/v3/series`, {
                    headers: { 'X-Api-Key': sonarrApiKey },
                    timeout: 15000,
                });

                const allSeries = JSON.parse(allSeriesRes.getBody('utf8'));
                let show = null;

                // Check each series for matching episode file
                for (const s of allSeries) {
                    if (s.id) {
                        try {
                            // Get episode files for this series
                            const episodeFilesRes = request('GET', `${sonarrHost}/api/v3/episodefile?seriesId=${s.id}`, {
                                headers: { 'X-Api-Key': sonarrApiKey },
                                timeout: 10000,
                            });
                            const episodeFiles = JSON.parse(episodeFilesRes.getBody('utf8'));

                            // Check if any episode file path matches
                            for (const ef of episodeFiles) {
                                if (ef.path === path) {
                                    show = s;
                                    response.infoLog += `[RenameTrigger] Found series by episode file path: ${show.title} (id=${show.id})\n`;
                                    break;
                                }
                            }
                            if (show) break;
                        } catch (e) {
                            // Skip series if episode file lookup fails
                        }
                    }
                }

                // Fallback: match by external IDs when the path lookup missed
                if (!show) {
                    if (tvdb || imdb || tmdb) {
                        response.infoLog += `[RenameTrigger] File not found by path, trying ID match against series list...\n`;
                        show = findByExternalIds(allSeries, [['tvdbId', tvdb, true], ['imdbId', imdb], ['tmdbId', tmdb, true]]);
                        if (show) {
                            response.infoLog += `[RenameTrigger] Found series by ID: ${show.title} (id=${show.id})\n`;
                        }
                    } else {
                        response.infoLog += '[RenameTrigger] No tvdb/tmdb/imdb ID found and file not in Sonarr.\n';
                    }
                }

                if (!show || !show.id) {
                    response.infoLog += '[RenameTrigger] Sonarr: series not found in Sonarr.\n';
                } else {
                    response.infoLog += `[RenameTrigger] Using series: ${show.title} (id=${show.id})\n`;
                    refreshProbeAndRename({
                        serviceName: 'Sonarr',
                        host: sonarrHost,
                        apiKey: sonarrApiKey,
                        id: show.id,
                        refreshName: 'RefreshSeries',
                        renameName: 'RenameSeries',
                        idsKey: 'seriesIds',
                        probeParam: 'seriesId',
                    });
                }
            }
        }
    } catch (err) {
        response.infoLog += `[RenameTrigger] ✗ Error: ${err.message}\n`;
    }

    return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
