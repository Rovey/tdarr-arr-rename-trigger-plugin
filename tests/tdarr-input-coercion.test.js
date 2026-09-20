'use strict';

// Tdarr casts inputs before the plugin runs, driven by the `type` each input
// declares in details(). For a 'number' input it uses Number(), so a value a
// user typed wrong ("abc", "20s") arrives as 0 — indistinguishable from an
// explicit 0, which means "never wait". Declaring rescan_wait_seconds as a
// string keeps the typed value intact so the plugin can fall back to its own
// default instead.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { loadPlugin, runPlugin, jsonHeaders } = require('./helpers/plugin-harness');

const RADARR_HOST = 'http://radarr.test:7878';
const RADARR_KEY = 'test-radarr-key';
const MOVIE_PATH = '/movies/Example Movie (2020)/Example Movie (2020).mkv';

const getOptions = (apiKey, timeout) => ({ headers: { 'X-Api-Key': apiKey }, timeout });
const postOptions = (apiKey, body) => ({ headers: jsonHeaders(apiKey), body, timeout: 10000 });

const declaredInput = (name) => loadPlugin().details().Inputs.find((input) => input.name === name);

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

const pollCall = {
  method: 'GET',
  url: `${RADARR_HOST}/api/v3/command/104`,
  options: getOptions(RADARR_KEY, 10000),
};
const rescanCall = {
  method: 'POST',
  url: `${RADARR_HOST}/api/v3/command`,
  options: postOptions(RADARR_KEY, '{"name":"RescanMovie","movieId":7}'),
};

test('rescan_wait_seconds is declared as a string so Tdarr does not cast it', () => {
  const input = declaredInput('rescan_wait_seconds');

  assert.equal(input.type, 'string');
  assert.equal(input.defaultValue, '15');
  assert.equal(input.inputUI.type, 'text');
});

test('a mistyped wait survives Tdarr and falls back to the default instead of never waiting', () => {
  const { response, calls } = runWithWait('abc');

  assert.match(response.infoLog, /RescanMovie finished with status: completed/);
  assert.ok(calls.includes(pollCall) || calls.some((call) => call.url === pollCall.url),
    'the rescan is polled, so the wait was not silently turned into 0');
});

test('a wait with a stray suffix falls back to the default as well', () => {
  const { response } = runWithWait('20s');

  assert.match(response.infoLog, /RescanMovie finished with status: completed/);
});

test('a numeric string is still read as seconds', () => {
  const { response, calls } = runWithWait('30');

  assert.match(response.infoLog, /RescanMovie finished with status: completed/);
  assert.ok(calls.some((call) => call.url === rescanCall.url));
});

test('an explicit 0 still means never wait', () => {
  const { response, calls } = runWithWait('0');

  assert.match(
    response.infoLog,
    /Not waiting for the rescan \(rescan_wait_seconds = 0\) — rename deferred to a later run\./,
  );
  assert.ok(!calls.some((call) => call.url === pollCall.url), 'no rescan poll is issued');
});

test('leaving the input empty uses the declared default', () => {
  const { response } = runWithWait('');

  assert.match(response.infoLog, /RescanMovie finished with status: completed/);
});
