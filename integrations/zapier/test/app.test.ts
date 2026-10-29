import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import App from '../src';

// The same compile-then-validate steps `zapier validate` runs, from the platform's own code.
const platform = require('zapier-platform-core/src/tools/schema') as {
  compileApp(app: object): object;
  validateApp(compiled: object): Array<{ stack: string }>;
};

const app = App as unknown as {
  triggers: Record<string, any>;
  creates: Record<string, any>;
  searches: Record<string, any>;
  authentication: any;
};

describe('app definition', () => {
  it('passes the Zapier platform schema', () => {
    const errors = platform.validateApp(platform.compileApp({ ...App }));
    assert.deepEqual(errors.map((error) => error.stack), []);
  });

  it('offers the planned triggers, actions and searches', () => {
    const visible = Object.values(app.triggers).filter((trigger) => !trigger.display.hidden);
    assert.deepEqual(
      visible.map((trigger) => trigger.display.label),
      ['Clips Ready', 'Export Finished', 'Finishing Ready', 'Autopilot Episode Imported', 'Post Published', 'Post Needs Attention'],
    );
    assert.deepEqual(
      Object.values(app.creates).map((create) => create.display.label),
      ['Submit Video Link', 'Generate Clips', 'Export Clip', 'Propose Social Post'],
    );
    assert.deepEqual(
      Object.values(app.searches).map((search) => search.display.label),
      ['Find Project', 'Get Export Download'],
    );
  });

  it('keeps the dropdown triggers hidden and every dynamic dropdown pointing at one', () => {
    for (const key of ['brand_profile_list', 'social_account_list']) assert.equal(app.triggers[key].display.hidden, true);
    const dynamic = [...Object.values(app.creates), ...Object.values(app.searches)]
      .flatMap((entry) => entry.operation.inputFields)
      .filter((field) => typeof field === 'object' && field.dynamic)
      .map((field) => field.dynamic as string);
    assert.deepEqual(dynamic.sort(), ['brand_profile_list.id.name', 'social_account_list.id.name']);
    for (const reference of dynamic) assert.ok(app.triggers[reference.split('.')[0] as string]);
  });

  it('gives every trigger a sample whose id is the event ID', () => {
    for (const trigger of Object.values(app.triggers)) {
      assert.equal(typeof trigger.operation.sample.id, 'string', trigger.key);
    }
  });

  it('authenticates with an API key and a configurable URL that defaults to the local API origin', () => {
    assert.equal(app.authentication.type, 'custom');
    const [apiKey, baseUrl] = app.authentication.fields;
    assert.equal(apiKey.key, 'apiKey');
    assert.equal(apiKey.type, 'password');
    assert.equal(baseUrl.key, 'baseUrl');
    assert.equal(baseUrl.default, 'http://localhost:4000');
    assert.notEqual(baseUrl.required, true);
  });
});
