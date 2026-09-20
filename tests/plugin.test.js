'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { runPlugin, jsonHeaders } = require('./helpers/plugin-harness');

const RADARR_HOST = 'http://radarr.test:7878';
const SONARR_HOST = 'http://sonarr.test:8989';
const RADARR_KEY = 'test-radarr-key';
const SONARR_KEY = 'test-sonarr-key';

const MOVIE_PATH = '/movies/Example Movie (2020)/Example Movie (2020).mkv';
const EPISODE_PATH = '/tv/Example Show/Season 01/Example Show - S01E01.mkv';

const getOptions = (apiKey, timeout) => ({ headers: { 'X-Api-Key': apiKey }, timeout });
const postOptions = (apiKey, body) => ({ headers: jsonHeaders(apiKey), body, timeout: 10000 });

test('returns the untouched response when the file path is missing', () => {
  const { response, calls } = runPlugin({ file: {} });

  assert.deepEqual(response, {
    processFile: false,
    preset: '',
    container: '.mkv',
    handBrakeMode: false,
    FFmpegMode: false,
    reQueueAfter: false,
    infoLog: '[RenameTrigger] File path missing from Tdarr context.\n',
  });
  assert.deepEqual(calls, []);
});

test('skips and reports both path checks when the path matches no enabled service', () => {
  const { response, calls } = runPlugin({
    file: { file: '/music/Example Album/track.mkv' },
    inputs: { radarr_api_key: RADARR_KEY, sonarr_api_key: SONARR_KEY },
  });

  assert.equal(
    response.infoLog,
    '[RenameTrigger] Path: /music/Example Album/track.mkv\n'
    + '[RenameTrigger] Path does not match any enabled service. Skipping.\n'
    + "[RenameTrigger] Radarr enabled: true, path check: '/movies/'\n"
    + "[RenameTrigger] Sonarr enabled: true, path check: '/tv/'\n",
  );
  assert.deepEqual(calls, []);
});

test('reports a missing Radarr host or API key without calling the API', () => {
  const { response, calls } = runPlugin({
    file: { file: MOVIE_PATH },
    inputs: { radarr_host: '', radarr_api_key: '' },
  });

  assert.equal(
    response.infoLog,
    `[RenameTrigger] Path: ${MOVIE_PATH}\n`
    + "[RenameTrigger] Path contains '/movies/' → Using Radarr\n"
    + '[RenameTrigger] Detected IDs → imdb:- tmdb:- tvdb:-\n'
    + '[RenameTrigger] Radarr: Missing host or API key.\n',
  );
  assert.deepEqual(calls, []);
});

test('Radarr: finds the movie by file path, rescans and then fires RenameMovie', () => {
  const { response, calls } = runPlugin({
    file: { file: MOVIE_PATH },
    // The trailing slash pins the host normalisation.
    inputs: { radarr_host: `${RADARR_HOST}/`, radarr_api_key: RADARR_KEY, sonarr_enabled: false },
    routes: [
      {
        method: 'GET',
        url: `${RADARR_HOST}/api/v3/movie`,
        body: [
          { id: 6, title: 'Another Movie', movieFile: { path: '/movies/Another Movie (2019)/Another Movie (2019).mkv' } },
          { id: 7, title: 'Example Movie', movieFile: { path: MOVIE_PATH } },
        ],
      },
      { method: 'GET', url: `${RADARR_HOST}/api/v3/rename?movieId=7`, body: [] },
      { method: 'POST', url: `${RADARR_HOST}/api/v3/command`, body: { id: 101, status: 'queued' } },
      { method: 'GET', url: `${RADARR_HOST}/api/v3/command/101`, body: { id: 101, status: 'completed' } },
      {
        method: 'GET',
        url: `${RADARR_HOST}/api/v3/rename?movieId=7`,
        body: [{ movieFileId: 70, existingPath: 'old.mkv', newPath: 'new.mkv' }],
      },
      {
        method: 'POST',
        url: `${RADARR_HOST}/api/v3/command`,
        statusCode: 201,
        body: { id: 102, status: 'queued' },
      },
    ],
  });

  assert.equal(
    response.infoLog,
    `[RenameTrigger] Path: ${MOVIE_PATH}\n`
    + "[RenameTrigger] Path contains '/movies/' → Using Radarr\n"
    + '[RenameTrigger] Detected IDs → imdb:- tmdb:- tvdb:-\n'
    + `[RenameTrigger] Processing with Radarr at ${RADARR_HOST}\n`
    + '[RenameTrigger] Looking up movie by file path...\n'
    + '[RenameTrigger] Found movie by file path: Example Movie (id=7)\n'
    + '[RenameTrigger] Using movie: Example Movie (id=7)\n'
    + '[RenameTrigger] Triggering RescanMovie...\n'
    + '[RenameTrigger] RescanMovie finished with status: completed\n'
    + '[RenameTrigger] RenameMovie fired (201)\n',
  );
  assert.deepEqual(calls, [
    { method: 'GET', url: `${RADARR_HOST}/api/v3/movie`, options: getOptions(RADARR_KEY, 15000) },
    { method: 'GET', url: `${RADARR_HOST}/api/v3/rename?movieId=7`, options: getOptions(RADARR_KEY, 10000) },
    {
      method: 'POST',
      url: `${RADARR_HOST}/api/v3/command`,
      options: postOptions(RADARR_KEY, '{"name":"RescanMovie","movieId":7}'),
    },
    { method: 'GET', url: `${RADARR_HOST}/api/v3/command/101`, options: getOptions(RADARR_KEY, 10000) },
    { method: 'GET', url: `${RADARR_HOST}/api/v3/rename?movieId=7`, options: getOptions(RADARR_KEY, 10000) },
    {
      method: 'POST',
      url: `${RADARR_HOST}/api/v3/command`,
      options: postOptions(RADARR_KEY, '{"name":"RenameMovie","movieIds":[7]}'),
    },
  ]);
});

test('Radarr: falls back to an imdb match against the already fetched movie list', () => {
  const idPath = '/movies/Example Movie (2020) [imdb-tt1375666]/Example Movie (2020).mkv';
  const { response, calls } = runPlugin({
    file: { file: idPath },
    inputs: {
      radarr_host: RADARR_HOST,
      radarr_api_key: RADARR_KEY,
      sonarr_enabled: false,
      refresh_first: false,
    },
    routes: [
      {
        method: 'GET',
        url: `${RADARR_HOST}/api/v3/movie`,
        body: [
          { id: 41, title: 'Another Movie', imdbId: 'tt0000041', tmdbId: 41, movieFile: { path: '/movies/other.mkv' } },
          { id: 42, title: 'Example Movie', imdbId: 'tt1375666', tmdbId: 42 },
        ],
      },
      {
        method: 'GET',
        url: `${RADARR_HOST}/api/v3/rename?movieId=42`,
        body: [{ movieFileId: 420, existingPath: 'old.mkv', newPath: 'new.mkv' }],
      },
      {
        method: 'POST',
        url: `${RADARR_HOST}/api/v3/command`,
        statusCode: 201,
        body: { id: 103, status: 'queued' },
      },
    ],
  });

  assert.equal(
    response.infoLog,
    `[RenameTrigger] Path: ${idPath}\n`
    + "[RenameTrigger] Path contains '/movies/' → Using Radarr\n"
    + '[RenameTrigger] Detected IDs → imdb:tt1375666 tmdb:- tvdb:-\n'
    + `[RenameTrigger] Processing with Radarr at ${RADARR_HOST}\n`
    + '[RenameTrigger] Looking up movie by file path...\n'
    + '[RenameTrigger] File not found by path, trying ID match against movie list...\n'
    + '[RenameTrigger] Found movie by ID: Example Movie (id=42)\n'
    + '[RenameTrigger] Using movie: Example Movie (id=42)\n'
    + '[RenameTrigger] RenameMovie fired (201)\n',
  );
  assert.deepEqual(calls, [
    { method: 'GET', url: `${RADARR_HOST}/api/v3/movie`, options: getOptions(RADARR_KEY, 15000) },
    { method: 'GET', url: `${RADARR_HOST}/api/v3/rename?movieId=42`, options: getOptions(RADARR_KEY, 10000) },
    {
      method: 'POST',
      url: `${RADARR_HOST}/api/v3/command`,
      options: postOptions(RADARR_KEY, '{"name":"RenameMovie","movieIds":[42]}'),
    },
  ]);
});

test('Sonarr: matches the series folder prefix, rescans and then fires RenameSeries', () => {
  const { response, calls } = runPlugin({
    file: { file: EPISODE_PATH },
    inputs: { sonarr_host: SONARR_HOST, sonarr_api_key: SONARR_KEY, radarr_enabled: false },
    routes: [
      {
        method: 'GET',
        url: `${SONARR_HOST}/api/v3/series`,
        body: [
          { id: 2, title: 'Another Show', path: '/tv/Another Show' },
          { id: 3, title: 'Example Show', path: '/tv/Example Show' },
        ],
      },
      { method: 'GET', url: `${SONARR_HOST}/api/v3/rename?seriesId=3`, body: [] },
      { method: 'POST', url: `${SONARR_HOST}/api/v3/command`, body: { id: 55, status: 'queued' } },
      { method: 'GET', url: `${SONARR_HOST}/api/v3/command/55`, body: { id: 55, status: 'completed' } },
      {
        method: 'GET',
        url: `${SONARR_HOST}/api/v3/rename?seriesId=3`,
        body: [{ episodeFileId: 300, existingPath: 'old.mkv', newPath: 'new.mkv' }],
      },
      {
        method: 'POST',
        url: `${SONARR_HOST}/api/v3/command`,
        statusCode: 201,
        body: { id: 56, status: 'queued' },
      },
    ],
  });

  assert.equal(
    response.infoLog,
    `[RenameTrigger] Path: ${EPISODE_PATH}\n`
    + "[RenameTrigger] Path contains '/tv/' → Using Sonarr\n"
    + '[RenameTrigger] Detected IDs → imdb:- tmdb:- tvdb:-\n'
    + `[RenameTrigger] Processing with Sonarr at ${SONARR_HOST}\n`
    + '[RenameTrigger] Looking up series by episode file path...\n'
    + '[RenameTrigger] Matched series folder: Example Show (id=3)\n'
    + '[RenameTrigger] Using series: Example Show (id=3)\n'
    + '[RenameTrigger] Triggering RescanSeries...\n'
    + '[RenameTrigger] RescanSeries finished with status: completed\n'
    + '[RenameTrigger] RenameSeries fired (201)\n',
  );
  assert.deepEqual(calls, [
    { method: 'GET', url: `${SONARR_HOST}/api/v3/series`, options: getOptions(SONARR_KEY, 15000) },
    { method: 'GET', url: `${SONARR_HOST}/api/v3/rename?seriesId=3`, options: getOptions(SONARR_KEY, 10000) },
    {
      method: 'POST',
      url: `${SONARR_HOST}/api/v3/command`,
      options: postOptions(SONARR_KEY, '{"name":"RescanSeries","seriesId":3}'),
    },
    { method: 'GET', url: `${SONARR_HOST}/api/v3/command/55`, options: getOptions(SONARR_KEY, 10000) },
    { method: 'GET', url: `${SONARR_HOST}/api/v3/rename?seriesId=3`, options: getOptions(SONARR_KEY, 10000) },
    {
      method: 'POST',
      url: `${SONARR_HOST}/api/v3/command`,
      options: postOptions(SONARR_KEY, '{"name":"RenameSeries","seriesIds":[3]}'),
    },
  ]);
});

test('reads the Radarr API key from RADARR_API_KEY when the input is empty', () => {
  const noMatchPath = '/movies/Missing Movie (2021)/Missing Movie (2021).mkv';
  const { response, calls } = runPlugin({
    file: { file: noMatchPath },
    inputs: { radarr_host: RADARR_HOST, radarr_api_key: '', sonarr_enabled: false },
    env: { RADARR_API_KEY: 'test-radarr-env-key' },
    routes: [{ method: 'GET', url: `${RADARR_HOST}/api/v3/movie`, body: [] }],
  });

  assert.equal(
    response.infoLog,
    `[RenameTrigger] Path: ${noMatchPath}\n`
    + "[RenameTrigger] Path contains '/movies/' → Using Radarr\n"
    + '[RenameTrigger] Detected IDs → imdb:- tmdb:- tvdb:-\n'
    + `[RenameTrigger] Processing with Radarr at ${RADARR_HOST}\n`
    + '[RenameTrigger] Looking up movie by file path...\n'
    + '[RenameTrigger] No imdb/tmdb ID found and file not in Radarr.\n'
    + '[RenameTrigger] Radarr: movie not found in Radarr.\n',
  );
  assert.deepEqual(calls, [
    { method: 'GET', url: `${RADARR_HOST}/api/v3/movie`, options: getOptions('test-radarr-env-key', 15000) },
  ]);
});

test('defers the rename when rescan_wait_seconds is 0', () => {
  const { response, calls } = runPlugin({
    file: { file: MOVIE_PATH },
    inputs: {
      radarr_host: RADARR_HOST,
      radarr_api_key: RADARR_KEY,
      sonarr_enabled: false,
      rescan_wait_seconds: 0,
    },
    routes: [
      {
        method: 'GET',
        url: `${RADARR_HOST}/api/v3/movie`,
        body: [{ id: 7, title: 'Example Movie', movieFile: { path: MOVIE_PATH } }],
      },
      { method: 'GET', url: `${RADARR_HOST}/api/v3/rename?movieId=7`, body: [] },
      { method: 'POST', url: `${RADARR_HOST}/api/v3/command`, body: { id: 104, status: 'queued' } },
    ],
  });

  assert.equal(
    response.infoLog,
    `[RenameTrigger] Path: ${MOVIE_PATH}\n`
    + "[RenameTrigger] Path contains '/movies/' → Using Radarr\n"
    + '[RenameTrigger] Detected IDs → imdb:- tmdb:- tvdb:-\n'
    + `[RenameTrigger] Processing with Radarr at ${RADARR_HOST}\n`
    + '[RenameTrigger] Looking up movie by file path...\n'
    + '[RenameTrigger] Found movie by file path: Example Movie (id=7)\n'
    + '[RenameTrigger] Using movie: Example Movie (id=7)\n'
    + '[RenameTrigger] Triggering RescanMovie...\n'
    + '[RenameTrigger] Rescan still busy — rename deferred to a later run.\n',
  );
  assert.deepEqual(calls, [
    { method: 'GET', url: `${RADARR_HOST}/api/v3/movie`, options: getOptions(RADARR_KEY, 15000) },
    { method: 'GET', url: `${RADARR_HOST}/api/v3/rename?movieId=7`, options: getOptions(RADARR_KEY, 10000) },
    {
      method: 'POST',
      url: `${RADARR_HOST}/api/v3/command`,
      options: postOptions(RADARR_KEY, '{"name":"RescanMovie","movieId":7}'),
    },
  ]);
});

test('reports that no rename is needed when nothing is pending after the rescan', () => {
  const { response } = runPlugin({
    file: { file: MOVIE_PATH },
    inputs: { radarr_host: RADARR_HOST, radarr_api_key: RADARR_KEY, sonarr_enabled: false },
    routes: [
      {
        method: 'GET',
        url: `${RADARR_HOST}/api/v3/movie`,
        body: [{ id: 7, title: 'Example Movie', movieFile: { path: MOVIE_PATH } }],
      },
      { method: 'GET', url: `${RADARR_HOST}/api/v3/rename?movieId=7`, body: [] },
      { method: 'POST', url: `${RADARR_HOST}/api/v3/command`, body: { id: 105, status: 'queued' } },
      { method: 'GET', url: `${RADARR_HOST}/api/v3/command/105`, body: { id: 105, status: 'completed' } },
      { method: 'GET', url: `${RADARR_HOST}/api/v3/rename?movieId=7`, body: [] },
    ],
  });

  assert.match(response.infoLog, /\[RenameTrigger\] RescanMovie finished with status: completed\n/);
  assert.ok(response.infoLog.endsWith('[RenameTrigger] ✓ No rename needed.\n'));
});

test('catches request failures and logs them without throwing', () => {
  const { response } = runPlugin({
    file: { file: MOVIE_PATH },
    inputs: { radarr_host: RADARR_HOST, radarr_api_key: RADARR_KEY, sonarr_enabled: false },
    routes: [{ method: 'GET', url: `${RADARR_HOST}/api/v3/movie`, error: 'connect ECONNREFUSED' }],
  });

  assert.equal(
    response.infoLog,
    `[RenameTrigger] Path: ${MOVIE_PATH}\n`
    + "[RenameTrigger] Path contains '/movies/' → Using Radarr\n"
    + '[RenameTrigger] Detected IDs → imdb:- tmdb:- tvdb:-\n'
    + `[RenameTrigger] Processing with Radarr at ${RADARR_HOST}\n`
    + '[RenameTrigger] Looking up movie by file path...\n'
    + '[RenameTrigger] ✗ Error: connect ECONNREFUSED\n',
  );
  assert.equal(response.processFile, false);
});
