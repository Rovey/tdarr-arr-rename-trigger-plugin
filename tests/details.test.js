'use strict';

const assert = require('node:assert/strict');
const nodePath = require('node:path');
const { test } = require('node:test');

const { PLUGIN_PATH, loadPlugin } = require('./helpers/plugin-harness');

const plugin = loadPlugin();

// Tdarr stores these values in its database and shows them in its UI, so they
// are a contract: changing one silently changes an existing installation.
const EXPECTED_INPUTS = [
  {
    name: 'radarr_enabled',
    type: 'boolean',
    defaultValue: true,
    inputUI: { type: 'dropdown', options: ['true', 'false'] },
  },
  {
    name: 'radarr_path_contains',
    type: 'string',
    defaultValue: '/movies/',
    inputUI: { type: 'text' },
  },
  {
    name: 'radarr_host',
    type: 'string',
    defaultValue: 'http://localhost:7878',
    inputUI: { type: 'text' },
  },
  {
    name: 'radarr_api_key',
    type: 'string',
    defaultValue: '',
    inputUI: { type: 'text' },
  },
  {
    name: 'sonarr_enabled',
    type: 'boolean',
    defaultValue: true,
    inputUI: { type: 'dropdown', options: ['true', 'false'] },
  },
  {
    name: 'sonarr_path_contains',
    type: 'string',
    defaultValue: '/tv/',
    inputUI: { type: 'text' },
  },
  {
    name: 'sonarr_host',
    type: 'string',
    defaultValue: 'http://localhost:8989',
    inputUI: { type: 'text' },
  },
  {
    name: 'sonarr_api_key',
    type: 'string',
    defaultValue: '',
    inputUI: { type: 'text' },
  },
  {
    name: 'refresh_first',
    type: 'boolean',
    defaultValue: true,
    inputUI: { type: 'dropdown', options: ['true', 'false'] },
  },
  {
    name: 'rescan_wait_seconds',
    // A string, so Tdarr's Number() cast cannot turn a mistyped value into 0.
    type: 'string',
    defaultValue: '15',
    inputUI: { type: 'text' },
  },
];

test('module exposes the Tdarr plugin API', () => {
  assert.deepEqual(plugin.dependencies, ['sync-request']);
  assert.equal(typeof plugin.details, 'function');
  assert.equal(typeof plugin.plugin, 'function');
});

test('details() reports the identity Tdarr keys plugins on', () => {
  const details = plugin.details();

  assert.equal(details.id, 'Tdarr_Plugin_rovey_arr_rename_trigger');
  assert.equal(details.Stage, 'Post-processing');
  assert.equal(details.Name, 'Trigger Radarr/Sonarr Rename');
  assert.equal(details.Type, 'Video');
  assert.equal(details.Operation, 'Transcode');
  assert.equal(details.Version, '1.5.1');
  assert.equal(details.Tags, 'post-processing,3rd party,radarr,sonarr');
});

test('plugin file name matches details().id, which is how Tdarr loads it', () => {
  assert.equal(nodePath.basename(PLUGIN_PATH, '.js'), plugin.details().id);
});

test('details() declares every input with its name, type and default value', () => {
  const inputs = plugin.details().Inputs;

  assert.equal(inputs.length, EXPECTED_INPUTS.length);
  assert.deepEqual(inputs.map((input) => input.name), EXPECTED_INPUTS.map((input) => input.name));

  for (const [index, expected] of EXPECTED_INPUTS.entries()) {
    const actual = inputs[index];
    assert.equal(actual.name, expected.name, `input ${index} name`);
    assert.equal(actual.type, expected.type, `input ${expected.name} type`);
    assert.deepEqual(actual.defaultValue, expected.defaultValue, `input ${expected.name} defaultValue`);
    assert.deepEqual(actual.inputUI, expected.inputUI, `input ${expected.name} inputUI`);
    assert.equal(typeof actual.tooltip, 'string', `input ${expected.name} tooltip`);
  }
});
