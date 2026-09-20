'use strict';

// How `rescan_wait_seconds` is read. Tdarr sends the value as a string, and a
// value it cannot make sense of must fall back to the declared 15 s default
// rather than silently meaning "never wait".

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { runPlugin, jsonHeaders } = require('./helpers/plugin-harness');

const RADARR_HOST = 'http://radarr.test:7878';
const RADARR_KEY = 'test-radarr-key';
const MOVIE_PATH = '/movies/Example Movie (2020)/Example Movie (2020).mkv';

const getOptions = (apiKey, timeout) => ({ headers: { 'X-Api-Key': apiKey }, timeout });
const postOptions = (apiKey, body) => ({ headers: jsonHeaders(apiKey), body, timeout: 10000 });

const runWithWait = (rescanWaitSeconds) => runPlugin({
  file: { file: MOVIE_PATH },
  inputs: {
    radarr_host: RADARR_HOST,
    radarr_api_key: RADARR_KEY,
    sonarr_enabled: false,
    rescan_wait_seconds: rescanWaitSeconds,
  },
  routes: [
    {
      method: 'GET',
      url: `${RADARR_HOST}/api/v3/movie`,
      body: [{ id: 7, title: 'Example Movie', movieFile: { path: MOVIE_PATH } }],
    },
    { method: 'GET', url: `${RADARR_HOST}/api/v3/rename?movieId=7`, body: [] },
    { method: 'POST', url: `${RADARR_HOST}/api/v3/command`, body: { id: 104, status: 'queued' } },
    { method: 'GET', url: `${RADARR_HOST}/api/v3/command/104`, body: { status: 'completed' } },
    { method: 'GET', url: `${RADARR_HOST}/api/v3/rename?movieId=7`, body: [] },
  ],
});

const LOOKUP_LOG = `[RenameTrigger] Path: ${MOVIE_PATH}\n`
  + "[RenameTrigger] Path contains '/movies/' → Using Radarr\n"
  + '[RenameTrigger] Detected IDs → imdb:- tmdb:- tvdb:-\n'
  + `[RenameTrigger] Processing with Radarr at ${RADARR_HOST}\n`
  + '[RenameTrigger] Looking up movie by file path...\n'
  + '[RenameTrigger] Found movie by file path: Example Movie (id=7)\n'
  + '[RenameTrigger] Using movie: Example Movie (id=7)\n'
  + '[RenameTrigger] Triggering RescanMovie...\n';

const WAITED_LOG = LOOKUP_LOG
  + '[RenameTrigger] RescanMovie finished with status: completed\n'
  + '[RenameTrigger] ✓ No rename needed.\n';

const WAITED_CALLS = [
  { method: 'GET', url: `${RADARR_HOST}/api/v3/movie`, options: getOptions(RADARR_KEY, 15000) },
  { method: 'GET', url: `${RADARR_HOST}/api/v3/rename?movieId=7`, options: getOptions(RADARR_KEY, 10000) },
  {
    method: 'POST',
    url: `${RADARR_HOST}/api/v3/command`,
    options: postOptions(RADARR_KEY, '{"name":"RescanMovie","movieId":7}'),
  },
  { method: 'GET', url: `${RADARR_HOST}/api/v3/command/104`, options: getOptions(RADARR_KEY, 10000) },
  { method: 'GET', url: `${RADARR_HOST}/api/v3/rename?movieId=7`, options: getOptions(RADARR_KEY, 10000) },
];

test('waits for the rescan when rescan_wait_seconds is a number', () => {
  const { response, calls } = runWithWait(15);

  assert.equal(response.infoLog, WAITED_LOG);
  assert.deepEqual(calls, WAITED_CALLS);
});

test('waits the default 15 seconds when rescan_wait_seconds is not a number', () => {
  const { response, calls } = runWithWait('abc');

  assert.equal(response.infoLog, WAITED_LOG);
  assert.deepEqual(calls, WAITED_CALLS);
});

test('waits the default 15 seconds when rescan_wait_seconds is an empty string', () => {
  const { response, calls } = runWithWait('');

  assert.equal(response.infoLog, WAITED_LOG);
  assert.deepEqual(calls, WAITED_CALLS);
});

test('waits the default 15 seconds when rescan_wait_seconds is negative', () => {
  const { response, calls } = runWithWait(-5);

  assert.equal(response.infoLog, WAITED_LOG);
  assert.deepEqual(calls, WAITED_CALLS);
});

test('reads a numeric string as seconds', () => {
  const { response, calls } = runWithWait('15');

  assert.equal(response.infoLog, WAITED_LOG);
  assert.deepEqual(calls, WAITED_CALLS);
});

test('says it did not wait when rescan_wait_seconds is 0', () => {
  const { response, calls } = runWithWait(0);

  assert.equal(
    response.infoLog,
    LOOKUP_LOG
    + '[RenameTrigger] Not waiting for the rescan (rescan_wait_seconds = 0)'
    + ' — rename deferred to a later run.\n',
  );
  assert.deepEqual(calls, WAITED_CALLS.slice(0, 3));
});

test('says it did not wait when rescan_wait_seconds is the string 0', () => {
  const { response } = runWithWait('0');

  assert.match(response.infoLog, /Not waiting for the rescan \(rescan_wait_seconds = 0\)/);
});
