// Structural checks for the Make app definition. No dependencies:
// `node --test "integrations/make/test/*.test.mjs"` (Node 22 or newer).
//
// Make's IML is interpreted inside Make, so nothing here runs a request. These
// tests keep the definition loadable (every file parses, the manifest and the
// files agree) and keep the decisions that matter from drifting: every input
// that shapes a request is part of its Idempotency-Key, and the trigger's
// cursor never meets `order=desc`, which the REST API refuses.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === 'node_modules' || name === '.secrets') return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(root).map((path) => relative(root, path));
const read = (path) => readFileSync(join(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));

/** Every string in a JSON value, with the path that leads to it. */
function strings(value, path = '') {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((entry, index) => strings(entry, `${path}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => strings(entry, `${path}.${key}`));
  return [];
}

/** The IML variables a string reads, such as `parameters.finishing.topClips`. */
function references(text, scope) {
  return [...text.matchAll(new RegExp(`\\b${scope}\\.([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)`, 'g'))].map((match) => match[1]);
}

const manifest = json('makecomapp.json');
const modules = Object.entries(manifest.components.module);

/** The names a module's inputs declare, with the sub-fields of its collections. */
function declaredInputs(module) {
  const specs = [...json(module.codeFiles.staticParams), ...json(module.codeFiles.mappableParams)];
  const names = new Set();
  const visit = (spec, prefix) => {
    const name = prefix ? `${prefix}.${spec.name}` : spec.name;
    names.add(name);
    if (spec.type === 'collection' && Array.isArray(spec.spec)) for (const child of spec.spec) visit(child, name);
  };
  for (const spec of specs) visit(spec, '');
  return names;
}

test('every JSON and IML JSON file parses', () => {
  const targets = files.filter((path) => path.endsWith('.json'));
  assert.ok(targets.length > 40, 'expected the whole definition');
  for (const path of targets) assert.doesNotThrow(() => JSON.parse(read(path)), path);
});

test('the manifest and the files on disk agree', () => {
  const referenced = [
    ...Object.values(manifest.generalCodeFiles),
    ...Object.values(manifest.components).flatMap((group) => Object.values(group).flatMap((component) => Object.values(component.codeFiles ?? {}))),
  ];
  for (const path of referenced) assert.ok(files.includes(path), `${path} is in the manifest but missing`);
  const expected = new Set([...referenced, 'makecomapp.json', 'test/validate.test.mjs', '.gitignore']);
  for (const path of files) assert.ok(expected.has(path), `${path} is not in the manifest`);
});

test('components follow the documented code file names', () => {
  const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const codeNames = { communication: 'communication', epoch: 'epoch', staticParams: 'static-params', mappableParams: 'mappable-params', interface: 'interface', samples: 'samples', params: 'params' };
  for (const [kind, folder] of [['module', 'modules'], ['rpc', 'rpcs'], ['connection', 'connections']]) {
    for (const [name, component] of Object.entries(manifest.components[kind])) {
      for (const [code, path] of Object.entries(component.codeFiles)) {
        const extension = code === 'common' ? 'common.json' : `${codeNames[code]}.iml.json`;
        assert.equal(path, `${folder}/${kebab(name)}/${kebab(name)}.${extension}`);
      }
    }
  }
});

test('modules, RPCs and groups reference each other correctly', () => {
  const connections = Object.keys(manifest.components.connection);
  const rpcs = Object.keys(manifest.components.rpc);
  for (const component of [...Object.values(manifest.components.rpc), ...Object.values(manifest.components.module)]) {
    assert.ok(connections.includes(component.connection), `unknown connection ${component.connection}`);
  }
  for (const [name, module] of modules) {
    assert.ok(['trigger', 'action', 'search', 'universal'].includes(module.moduleType), `${name}: moduleType`);
    for (const [path, text] of strings([...json(module.codeFiles.staticParams), ...json(module.codeFiles.mappableParams)])) {
      for (const [, rpc] of text.matchAll(/^rpc:\/\/(\w+)$/g)) assert.ok(rpcs.includes(rpc), `${name}${path}: unknown RPC ${rpc}`);
    }
  }
  const grouped = json(manifest.generalCodeFiles.groups).flatMap((group) => group.modules);
  assert.deepEqual([...grouped].sort(), modules.map(([name]) => name).sort(), 'every module is in exactly one group');
  assert.equal(modules.filter(([, module]) => module.moduleType === 'universal').length, 1, 'an app has one universal module');
});

test('IML expressions are balanced and read only declared inputs', () => {
  const connectionInputs = new Set(json(manifest.components.connection.narriflow.codeFiles.params).map((spec) => spec.name));
  const everyString = files.filter((path) => path.endsWith('.json')).flatMap((path) => strings(json(path)).map(([where, text]) => [`${path}${where}`, text]));
  for (const [where, text] of everyString) {
    assert.equal((text.match(/\{\{/g) ?? []).length, (text.match(/\}\}/g) ?? []).length, `${where}: unbalanced mustaches`);
    for (const name of references(text, 'connection')) assert.ok(connectionInputs.has(name), `${where}: connection.${name} is not a connection input`);
  }
  for (const path of files.filter((entry) => entry.startsWith('connections/') && entry.includes('communication'))) {
    for (const [where, text] of strings(json(path))) for (const name of references(text, 'parameters')) assert.ok(connectionInputs.has(name), `${path}${where}: parameters.${name}`);
  }
  for (const [name, module] of modules) {
    const declared = declaredInputs(module);
    for (const [where, text] of strings(json(module.codeFiles.communication))) {
      for (const input of references(text, 'parameters')) assert.ok(declared.has(input), `${name}${where}: parameters.${input} is not declared`);
    }
  }
});

test('no secret or credential is committed', () => {
  for (const path of files.filter((entry) => entry.endsWith('.json') || entry.endsWith('.md'))) {
    const text = read(path);
    assert.doesNotMatch(text, /\bnf_[A-Za-z0-9_-]{8,}/, `${path}: a Narriflow API key`);
  }
  for (const path of files.filter((entry) => entry.endsWith('.json'))) {
    assert.doesNotMatch(read(path), /Bearer (?!\{\{)\S+/, `${path}: a literal bearer token`);
  }
  assert.deepEqual(json('general/common.json'), {});
  assert.deepEqual(json('connections/narriflow/narriflow.common.json'), {});
  assert.match(read('.gitignore'), /^\.secrets\/$/m);
});

test('the base authenticates every request and keeps the key out of logs', () => {
  const base = json('general/base.iml.json');
  assert.match(base.baseUrl, /\/api\/v1$/);
  assert.equal(base.headers.authorization, 'Bearer {{connection.apiKey}}');
  assert.deepEqual(base.log.sanitize, ['request.headers.authorization']);
  assert.equal(base.response.error['401'].type, 'InvalidAccessTokenError');
  // A missing scope won't fix itself on retry, so the scenario stops at once.
  assert.equal(base.response.error['403'].type, 'InvalidConfigurationError');
  assert.equal(base.response.error.type, undefined, 'a top-level error type would replace the rate limit and connection defaults');
  const connection = json('connections/narriflow/narriflow.communication.iml.json');
  assert.match(connection.url, /\/api\/v1\/workspace$/);
  assert.deepEqual(connection.log.sanitize, ['request.headers.authorization']);
});

test('the trigger reads forward from a persisted cursor and never combines it with order=desc', () => {
  const trigger = manifest.components.module.watchEvents;
  const communication = json(trigger.codeFiles.communication);
  const epoch = json(trigger.codeFiles.epoch);
  assert.equal(trigger.moduleType, 'trigger');
  assert.equal(communication.url, '/events');
  // Make keeps the last item's ID; the API's cursor is a seq, so the seq is the trigger's ID.
  assert.deepEqual(communication.response.trigger, { type: 'id', order: 'asc', id: '{{item.seq}}' });
  assert.equal(communication.qs.order, 'asc');
  // An empty cursor must be omitted: the API refuses `after=`.
  assert.equal(communication.qs.after, '{{ifempty(data.lastId, undefined)}}');
  assert.equal(communication.pagination.qs.after, '{{body.nextCursor}}');
  assert.equal(communication.pagination.condition, '{{length(body.data) = 100}}');
  assert.equal(communication.response.limit, '{{parameters.limit}}');
  // The Epoch panel lists the newest events, which the API only reads without `after`.
  assert.equal(epoch.qs.order, 'desc');
  // Override the inherited cursor explicitly in case Make merges `qs` key by key.
  assert.equal(epoch.qs.after, '{{undefined}}');
  assert.equal(epoch.pagination.condition, false);
  assert.equal(epoch.response.trigger.order, 'desc');
  assert.deepEqual(Object.keys(epoch.response.output).sort(), ['date', 'label']);
  assert.deepEqual(json(trigger.codeFiles.mappableParams), [], 'a polling trigger takes static parameters only');
  const types = json(trigger.codeFiles.staticParams).find((spec) => spec.name === 'types');
  assert.deepEqual(types.options.map((option) => option.value).sort(), ['autopilot.episode_imported', 'finishing.finished', 'operation.finished', 'social_post.finished']);
});

const KEY_ALPHABET = /^[A-Za-z0-9._~:-]+$/;

test('every action sends an Idempotency-Key built from all of its inputs', () => {
  const actions = modules.filter(([, module]) => module.moduleType === 'action');
  assert.equal(actions.length, 4);
  for (const [name, module] of actions) {
    const communication = json(module.codeFiles.communication);
    const requests = Array.isArray(communication) ? communication : [communication];
    const sent = requests.filter((request) => request.method === 'POST');
    assert.equal(sent.length, 1, `${name}: one request starts the work`);
    const [request] = sent;
    const header = request.headers['Idempotency-Key'];
    const slug = module.codeFiles.communication.split('/')[1];
    const match = /^make:([a-z-]+):\{\{sha256\((.+)\)\}\}$/.exec(header);
    assert.ok(match, `${name}: key shape`);
    assert.equal(match[1], slug, `${name}: key names its action`);
    // The literal part is URL-safe, the digest is 64 hex characters: well inside the API's 200.
    assert.match(`make:${slug}:${'0'.repeat(64)}`, KEY_ALPHABET);
    assert.ok(`make:${slug}:`.length + 64 <= 200);
    const inKey = new Set([...references(match[2], 'parameters'), ...references(match[2], 'temp').map((entry) => `temp.${entry}`)]);
    const shaping = [...strings([request.url, request.body]), ...strings(requests.slice(0, requests.indexOf(request)).map((previous) => previous.url))];
    for (const [where, text] of shaping) {
      for (const input of references(text, 'parameters')) {
        const covered = inKey.has(input) || [...inKey].some((key) => key.startsWith(`${input}.`));
        assert.ok(covered, `${name}${where}: parameters.${input} shapes the request but is not in the key`);
      }
      for (const input of references(text, 'temp')) assert.ok(inKey.has(`temp.${input}`), `${name}${where}: temp.${input} is not in the key`);
    }
    assert.ok(inKey.has('runKey'), `${name}: the Run key is part of the key`);
    assert.ok(declaredInputs(module).has('runKey'), `${name}: declares a Run key input`);
    assert.doesNotMatch(match[2], /\bnow\b|random|uuid/i, `${name}: nothing random or time-based in the key`);
  }
});

test('Export a clip reads the clip revision first and sends it', () => {
  const [read, send] = json(manifest.components.module.exportClip.codeFiles.communication);
  assert.equal(read.method, 'GET');
  assert.equal(read.response.temp.editorRevision, '{{body.clip.editorRevision}}');
  assert.equal(send.body.expectedRevision, '{{temp.editorRevision}}');
  assert.match(send.headers['Idempotency-Key'], /temp\.editorRevision/);
});

test('dropdowns come from the REST list endpoints', () => {
  const brandProfiles = json(manifest.components.rpc.listBrandProfiles.codeFiles.communication);
  assert.equal(brandProfiles.url, '/brand-profiles');
  assert.equal(brandProfiles.response.output.value, '{{item.brandProfileId}}');
  const accounts = json(manifest.components.rpc.listSocialAccounts.codeFiles.communication);
  assert.equal(accounts.url, '/social-accounts');
  assert.equal(accounts.response.output.value, '{{item.accountId}}');
  assert.equal(accounts.response.iterate.condition, "{{item.status = 'active'}}");
});

test('the export download search returns one bundle for each format', () => {
  const search = json(manifest.components.module.getExportDownload.codeFiles.communication);
  assert.equal(search.method, 'GET');
  assert.match(search.url, /^\/exports\/\{\{trim\(parameters\.exportId\)\}\}\/download$/);
  assert.equal(search.response.iterate, '{{body.variants}}');
  assert.equal(search.response.output.downloadUrl, '{{item.downloadUrl}}');
});

test('the universal module keeps requests on the connection’s host', () => {
  const call = json(manifest.components.module.makeAnApiCall.codeFiles.communication);
  // The path always follows a `/` after the host, so a pasted `@host` or `.host` cannot change it.
  assert.match(call.url, /^\{\{ifempty\(connection\.baseUrl, 'https:\/\/app\.narriflow\.com'\)\}\}\/\{\{parameters\.url\}\}$/);
});
