'use strict';

// Test harness for the Tdarr plugin.
//
// The plugin runs inside Tdarr, so two of its requires only resolve there:
//   - 'sync-request'    is installed by Tdarr from module.exports.dependencies
//   - '../methods/lib'  is part of the Tdarr host application
// Neither exists in this repository, and the plugin requires them from inside
// plugin(), so the harness patches Module._load for the duration of one call
// and restores it afterwards.
//
// 'fs' is stubbed as well: the plugin looks for an arr_credentials.json next to
// itself and in /app/configs/, and a real one on the machine running the tests
// would change which API key the plugin resolves. The stub only makes those two
// lookups miss; every other fs call goes to the real module.

const Module = require('node:module');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const PLUGIN_PATH = nodePath.join(__dirname, '..', '..', 'Tdarr_Plugin_rovey_arr_rename_trigger.js');
const CREDENTIALS_FILE_NAME = 'arr_credentials.json';

/**
 * Stand-in for Tdarr's '../methods/lib'. loadDefaultValues below is a faithful
 * copy of Tdarr's own implementation (server file
 * /app/server/Tdarr/Plugins/methods/loadDefaultValues.js, read from the running
 * container on 2026-09-20), because what it does to an input before the plugin
 * sees it is part of the behavior under test: it trims strings, substitutes the
 * declared defaultValue for undefined and '', casts a 'boolean' input to a real
 * boolean, and casts a 'number' input with Number() — turning anything
 * unparseable into 0.
 */
function createLibStub() {
  return () => ({
    loadDefaultValues(inputs, detailsSource) {
      const pluginDetails = typeof detailsSource === 'function' ? detailsSource() : detailsSource;
      const merged = Object.assign({}, inputs);
      const declaredInputs = pluginDetails.Inputs || pluginDetails.inputs || [];

      for (const declared of declaredInputs) {
        if (typeof merged[declared.name] === 'string') {
          merged[declared.name] = merged[declared.name].trim();
        }

        if (merged[declared.name] === undefined || merged[declared.name] === '') {
          merged[declared.name] = declared.defaultValue;
        }

        if (declared.type === 'boolean') {
          merged[declared.name] = !!(merged[declared.name] === 'true' || merged[declared.name] === true);
        }

        if (declared.type === 'number') {
          merged[declared.name] = Number(merged[declared.name]);
          if (Number.isNaN(merged[declared.name])) {
            merged[declared.name] = 0;
          }
        }
      }

      return merged;
    },
  });
}

/**
 * Stand-in for 'sync-request'. Routes are matched on "METHOD URL" in the order
 * they are declared, one route per call, so repeated calls to the same URL can
 * return different payloads. An unexpected call fails the test loudly.
 *
 * Route: { method, url, body, statusCode, error }
 */
function createRequestStub(routes) {
  const calls = [];
  const queues = new Map();

  for (const route of routes) {
    const key = `${route.method} ${route.url}`;
    if (!queues.has(key)) {
      queues.set(key, []);
    }
    queues.get(key).push(route);
  }

  const request = (method, url, options) => {
    calls.push({ method, url, options });

    const key = `${method} ${url}`;
    const queue = queues.get(key);
    if (!queue || queue.length === 0) {
      throw new Error(`Unexpected request: ${key}`);
    }

    const route = queue.shift();
    if (route.error) {
      throw new Error(route.error);
    }

    return {
      statusCode: route.statusCode === undefined ? 200 : route.statusCode,
      getBody: () => (typeof route.body === 'string' ? route.body : JSON.stringify(route.body)),
    };
  };

  return { request, calls };
}

function createFsStub() {
  const stub = Object.create(nodeFs);
  Object.defineProperty(stub, 'existsSync', {
    value: (target) => {
      if (String(target).endsWith(CREDENTIALS_FILE_NAME)) {
        return false;
      }
      return nodeFs.existsSync(target);
    },
  });
  return stub;
}

function applyEnv(env) {
  const previous = new Map();
  for (const name of Object.keys(env)) {
    previous.set(name, Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined);
    if (env[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = env[name];
    }
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

function loadPlugin() {
  return require(PLUGIN_PATH);
}

/**
 * Run plugin() once with mocked requires.
 *
 * @returns {{ response: object, calls: Array<{method: string, url: string, options: object}> }}
 */
function runPlugin({ file = {}, inputs = {}, routes = [], env = {} } = {}) {
  const pluginModule = loadPlugin();
  const { request, calls } = createRequestStub(routes);
  const libStub = createLibStub();
  const fsStub = createFsStub();

  // Both keys are cleared unless a test sets them, so the machine's own
  // environment cannot leak into the plugin's key resolution.
  const restoreEnv = applyEnv(Object.assign({ RADARR_API_KEY: undefined, SONARR_API_KEY: undefined }, env));
  const originalLoad = Module._load;

  Module._load = function patchedLoad(requestPath) {
    if (requestPath === 'sync-request') {
      return request;
    }
    if (requestPath === '../methods/lib') {
      return libStub;
    }
    if (requestPath === 'fs' || requestPath === 'node:fs') {
      return fsStub;
    }
    // eslint-disable-next-line prefer-rest-params
    return originalLoad.apply(this, arguments);
  };

  try {
    const response = pluginModule.plugin(file, {}, inputs, {});
    return { response, calls };
  } finally {
    Module._load = originalLoad;
    restoreEnv();
  }
}

function jsonHeaders(apiKey) {
  return { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' };
}

module.exports = {
  PLUGIN_PATH,
  loadPlugin,
  runPlugin,
  jsonHeaders,
};
