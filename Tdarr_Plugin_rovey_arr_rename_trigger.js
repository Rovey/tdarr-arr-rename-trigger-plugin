// List any npm dependencies which the plugin needs, they will be auto installed when the plugin runs:
module.exports.dependencies = [
    'sync-request',
];

const RESCAN_WAIT_DEFAULT_SECONDS = 15;

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
            defaultValue: RESCAN_WAIT_DEFAULT_SECONDS,
            inputUI: {
                type: 'text',
            },
            tooltip: 'Max seconds to wait for the rescan before deferring the rename to the next run (0 = never wait). Keeps the Tdarr worker from blocking on big-series rescans.',
        },
    ],
});

// Tdarr reads these fields off the object plugin() returns; this plugin only
// ever appends to infoLog and leaves the transcode fields untouched.
const createResponse = () => ({
    processFile: false,
    preset: '',
    container: '.mkv',
    handBrakeMode: false,
    FFmpegMode: false,
    reQueueAfter: false,
    infoLog: '',
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

// Tdarr hands inputs over as strings. A value we cannot read as a non-negative
// number means the wait was never configured, so it falls back to the declared
// default instead of 0, which would silently mean "never wait".
const parseRescanWaitSeconds = (value) => {
    const raw = value === undefined || value === null ? '' : String(value).trim();
    const seconds = typeof value === 'number' ? value : parseInt(raw, 10);
    if (!Number.isFinite(seconds) || seconds < 0) {
        return RESCAN_WAIT_DEFAULT_SECONDS;
    }
    return seconds;
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

// Radarr stores the exact file path of the movie file. Kept as a for..of loop
// so a non-array payload fails with the same TypeError text as before.
const findMovieByPath = (allMovies, path) => {
    for (const movie of allMovies) {
        if (movie.movieFile && movie.movieFile.path === path) {
            return movie;
        }
    }
    return null;
};

// The episode always lives under the series' root folder, so a prefix match on
// series.path finds the show without the per-series episodefile calls (up to
// ~90 sequential requests) this used to do.
const findSeriesByPath = (allSeries, path) => {
    for (const series of allSeries) {
        if (!series.path) continue;
        const folder = series.path.endsWith('/') ? series.path : `${series.path}/`;
        if (path.startsWith(folder)) {
            return series;
        }
    }
    return null;
};

// The captured tmdb/tvdb digits are strings; the *arr fields are numbers.
const ID_MATCHERS = {
    imdb: (value) => (item) => item.imdbId === value,
    tmdb: (value) => (item) => item.tmdbId === parseInt(value, 10),
    tvdb: (value) => (item) => item.tvdbId === parseInt(value, 10),
};

// Split per service so a non-array payload names the same variable in the
// TypeError as before.
const findMovieById = (allMovies, idName, value) => allMovies.find(ID_MATCHERS[idName](value));
const findSeriesById = (allSeries, idName, value) => allSeries.find(ID_MATCHERS[idName](value));

// Radarr and Sonarr run the same "probe pending renames -> optional rescan ->
// wait -> probe again -> fire rename" flow; only the endpoints, command names,
// ID fallback order and log wording differ.
const RADARR = {
    name: 'Radarr',
    entity: 'movie',
    listResource: 'movie',
    idParam: 'movieId',
    renameIdsField: 'movieIds',
    rescanCommand: 'RescanMovie',
    renameCommand: 'RenameMovie',
    lookupLine: '[RenameTrigger] Looking up movie by file path...\n',
    pathMatchLabel: 'Found movie by file path',
    findByPath: findMovieByPath,
    findById: findMovieById,
    idOrder: ['imdb', 'tmdb'],
    idNames: 'imdb/tmdb',
};

const SONARR = {
    name: 'Sonarr',
    entity: 'series',
    listResource: 'series',
    idParam: 'seriesId',
    renameIdsField: 'seriesIds',
    rescanCommand: 'RescanSeries',
    renameCommand: 'RenameSeries',
    lookupLine: '[RenameTrigger] Looking up series by episode file path...\n',
    pathMatchLabel: 'Matched series folder',
    findByPath: findSeriesByPath,
    findById: findSeriesById,
    idOrder: ['tvdb', 'imdb', 'tmdb'],
    idNames: 'tvdb/tmdb/imdb',
};

const readSettings = (inputs, log) => {
    const resolveApiKey = createApiKeyResolver(log);
    return {
        radarr: {
            service: RADARR,
            enabled: inputs.radarr_enabled === true,
            pathContains: (inputs.radarr_path_contains || '').trim(),
            host: normalizeHost(inputs.radarr_host),
            apiKey: resolveApiKey(inputs.radarr_api_key, 'RADARR_API_KEY', 'radarr_api_key'),
        },
        sonarr: {
            service: SONARR,
            enabled: inputs.sonarr_enabled === true,
            pathContains: (inputs.sonarr_path_contains || '').trim(),
            host: normalizeHost(inputs.sonarr_host),
            apiKey: resolveApiKey(inputs.sonarr_api_key, 'SONARR_API_KEY', 'sonarr_api_key'),
        },
        refreshFirst: inputs.refresh_first === true,
        rescanWaitMs: parseRescanWaitSeconds(inputs.rescan_wait_seconds) * 1000,
    };
};

// A path can match both services (e.g. "/movies/tv/"), and then both run,
// Radarr first.
const selectTargets = (log, settings, path) => {
    const targets = [];
    for (const key of ['radarr', 'sonarr']) {
        const config = settings[key];
        if (config.enabled && config.pathContains
            && path.toLowerCase().includes(config.pathContains.toLowerCase())) {
            log(`[RenameTrigger] Path contains '${config.pathContains}' → Using ${config.service.name}\n`);
            targets.push(Object.assign({}, config.service, { host: config.host, apiKey: config.apiKey }));
        }
    }
    return targets;
};

const logNoServiceMatch = (log, settings) => {
    log('[RenameTrigger] Path does not match any enabled service. Skipping.\n');
    log(`[RenameTrigger] Radarr enabled: ${settings.radarr.enabled}, path check: '${settings.radarr.pathContains}'\n`);
    log(`[RenameTrigger] Sonarr enabled: ${settings.sonarr.enabled}, path check: '${settings.sonarr.pathContains}'\n`);
};

// Everything the per-service flow needs, so the helpers below take one object
// instead of six positional arguments.
const createContext = (request, log, path, settings) => ({
    request,
    log,
    path,
    ids: extractIds(path),
    refreshFirst: settings.refreshFirst,
    rescanWaitMs: settings.rescanWaitMs,
});

const findEntity = (context, target, items) => {
    const byPath = target.findByPath(items, context.path);
    if (byPath) {
        context.log(`[RenameTrigger] ${target.pathMatchLabel}: ${byPath.title} (id=${byPath.id})\n`);
        return byPath;
    }

    if (!target.idOrder.some((idName) => context.ids[idName])) {
        context.log(`[RenameTrigger] No ${target.idNames} ID found and file not in ${target.name}.\n`);
        return null;
    }

    // Fallback: filter the already-fetched list client-side. Both APIs ignore
    // most ?imdbId=/?tmdbId= filters and silently return everything, so taking
    // [0] from a "filtered" call grabs the wrong title.
    context.log(`[RenameTrigger] File not found by path, trying ID match against ${target.entity} list...\n`);
    for (const idName of target.idOrder) {
        const value = context.ids[idName];
        const match = value ? target.findById(items, idName, value) : undefined;
        if (match) {
            context.log(`[RenameTrigger] Found ${target.entity} by ID: ${match.title} (id=${match.id})\n`);
            return match;
        }
    }
    return null;
};

const probePendingRenames = (context, target, id) => {
    try {
        const probeRes = context.request('GET', `${target.host}/api/v3/rename?${target.idParam}=${id}`, {
            headers: { 'X-Api-Key': target.apiKey },
            timeout: 10000,
        });
        const pending = JSON.parse(probeRes.getBody('utf8'));
        return Array.isArray(pending) ? pending.length : 0;
    } catch (e) {
        context.log(`[RenameTrigger] Rename probe failed: ${e.message}\n`);
        return 0;
    }
};

const fireRename = (context, target, id) => {
    const body = { name: target.renameCommand };
    body[target.renameIdsField] = [id];
    const renameRes = context.request('POST', `${target.host}/api/v3/command`, {
        headers: {
            'X-Api-Key': target.apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        timeout: 10000,
    });
    context.log(`[RenameTrigger] ${target.renameCommand} fired (${renameRes.statusCode})\n`);
};

// Rescan only re-reads the file from disk; the full Refresh would also hit the
// metadata provider, which the rename doesn't need.
const rescanThenRename = (context, target, id) => {
    context.log(`[RenameTrigger] Triggering ${target.rescanCommand}...\n`);
    const rescanBody = { name: target.rescanCommand };
    rescanBody[target.idParam] = id;
    const rescanRes = context.request('POST', `${target.host}/api/v3/command`, {
        headers: {
            'X-Api-Key': target.apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(rescanBody),
        timeout: 10000,
    });

    try {
        const rescanCmd = JSON.parse(rescanRes.getBody('utf8'));
        if (context.rescanWaitMs === 0) {
            context.log('[RenameTrigger] Not waiting for the rescan (rescan_wait_seconds = 0)'
                + ' — rename deferred to a later run.\n');
        } else if (rescanCmd && rescanCmd.id
            && waitForCommand(context.request, context.log, target.host, target.apiKey,
                rescanCmd.id, target.rescanCommand, context.rescanWaitMs)) {
            if (probePendingRenames(context, target, id) > 0) {
                fireRename(context, target, id);
            } else {
                context.log('[RenameTrigger] ✓ No rename needed.\n');
            }
        } else {
            context.log('[RenameTrigger] Rescan still busy — rename deferred to a later run.\n');
        }
    } catch (e) {
        context.log(`[RenameTrigger] Could not parse ${target.rescanCommand} response: ${e.message}\n`);
    }
};

const processTarget = (context, target) => {
    if (!target.host || !target.apiKey) {
        context.log(`[RenameTrigger] ${target.name}: Missing host or API key.\n`);
        return;
    }

    context.log(`[RenameTrigger] Processing with ${target.name} at ${target.host}\n`);
    context.log(target.lookupLine);

    const listRes = context.request('GET', `${target.host}/api/v3/${target.listResource}`, {
        headers: { 'X-Api-Key': target.apiKey },
        timeout: 15000,
    });
    const items = JSON.parse(listRes.getBody('utf8'));

    const found = findEntity(context, target, items);
    if (!found || !found.id) {
        context.log(`[RenameTrigger] ${target.name}: ${target.entity} not found in ${target.name}.\n`);
        return;
    }

    const id = found.id;
    context.log(`[RenameTrigger] Using ${target.entity}: ${found.title} (id=${id})\n`);

    // Renames are fire-and-forget: the *arr finishes them on its own, so
    // blocking the Tdarr worker on them adds nothing. Renames left pending by
    // earlier runs (e.g. rescans that outlived the wait window) go out first.
    if (probePendingRenames(context, target, id) > 0) {
        fireRename(context, target, id);
    }

    if (context.refreshFirst) {
        rescanThenRename(context, target, id);
    }
};

// eslint-disable-next-line no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {
    const lib = require('../methods/lib')();
    // eslint-disable-next-line no-unused-vars,no-param-reassign
    inputs = lib.loadDefaultValues(inputs, details);

    const response = createResponse();
    const request = require('sync-request');
    const log = (line) => {
        response.infoLog += line;
    };

    const settings = readSettings(inputs, log);

    const path = file.file || file._id || '';
    if (!path) {
        log('[RenameTrigger] File path missing from Tdarr context.\n');
        return response;
    }

    log(`[RenameTrigger] Path: ${path}\n`);

    const targets = selectTargets(log, settings, path);
    if (targets.length === 0) {
        logNoServiceMatch(log, settings);
        return response;
    }

    const context = createContext(request, log, path, settings);
    const { ids } = context;

    log(`[RenameTrigger] Detected IDs → imdb:${ids.imdb || '-'} tmdb:${ids.tmdb || '-'} tvdb:${ids.tvdb || '-'}\n`);

    try {
        for (const target of targets) {
            processTarget(context, target);
        }
    } catch (err) {
        log(`[RenameTrigger] ✗ Error: ${err.message}\n`);
    }

    return response;
};

module.exports.details = details;
module.exports.plugin = plugin;
