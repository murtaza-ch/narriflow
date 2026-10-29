import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import nock from 'nock';
import zapier from 'zapier-platform-core';
import App from '../src';
import { apiRoot } from '../src/api';
import { API_KEY, api, apiError, bundle, narriflow, uuid, zapierError } from './helpers';

const tester = zapier.createAppTester(App);
const auth = (App as unknown as { authentication: { test: any; connectionLabel: any } }).authentication;

before(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());

const workspace = {
  workspace: { workspaceId: uuid(1), name: 'Acme Studio', role: 'owner', status: 'active', pricingTier: 'business' },
  usage: {},
};

describe('authentication', () => {
  it('tests the key with GET /workspace and labels the connection with the Workspace name', async () => {
    const scope = narriflow().get(api('/workspace')).reply(200, workspace);
    const result = (await tester(auth.test, bundle() as never)) as typeof workspace;
    assert.equal(result.workspace.name, 'Acme Studio');
    assert.ok(scope.isDone());
    const label = await tester(auth.connectionLabel, { inputData: result } as never);
    assert.equal(label, 'Acme Studio');
  });

  it('shows Narriflow\'s own message when the key is refused', async () => {
    narriflow().get(api('/workspace')).reply(401, apiError('invalid_api_key', 'This API key is missing, invalid or revoked.'));
    await assert.rejects(tester(auth.test, bundle() as never), (err) => {
      assert.equal((err as Error).name, 'ExpiredAuthError');
      assert.match((err as Error).message, /missing, invalid or revoked/);
      return true;
    });
  });

  it('shows the plan error for a Workspace without API access', async () => {
    narriflow().get(api('/workspace')).reply(402, apiError('integration_access_unavailable', 'The Workspace needs active Business access.'));
    await assert.rejects(tester(auth.test, bundle() as never), (err) => {
      assert.equal(zapierError(err).code, 'integration_access_unavailable');
      return true;
    });
  });

  it('sends the key only as a Bearer token', async () => {
    const seen: string[] = [];
    nock('http://localhost:4000')
      .get(api('/workspace'))
      .reply((request: Request) => {
        seen.push(String(request.headers.get('authorization')));
        return [200, workspace];
      });
    await tester(auth.test, bundle() as never);
    assert.deepEqual(seen, [`Bearer ${API_KEY}`]);
  });
});

describe('Narriflow URL', () => {
  const root = (baseUrl?: string) => apiRoot({ errors: (zapier as any).errors } as never, { authData: { baseUrl } } as never);

  it('requires an explicitly configured API origin', () => {
    for (const value of [undefined, '', '   ']) assert.throws(() => root(value), (err) => zapierError(err).code === 'api_origin_required');
  });

  it('accepts a dev origin however it was pasted', () => {
    assert.equal(root('https://dev.example.com'), 'https://dev.example.com/api/v1');
    assert.equal(root('https://dev.example.com/'), 'https://dev.example.com/api/v1');
    assert.equal(root('https://dev.example.com/api/v1'), 'https://dev.example.com/api/v1');
    assert.equal(root(' http://localhost:4000/projects '), 'http://localhost:4000/api/v1');
  });

  it('refuses plain http to a remote host and text that is not a URL', () => {
    assert.throws(() => root('http://dev.example.com'), (err) => /https/.test(zapierError(err).message));
    assert.throws(() => root('narriflow'), (err) => /not a URL/.test(zapierError(err).message));
  });

  it('calls the configured origin', async () => {
    const scope = nock('https://dev.example.com').get(api('/workspace')).reply(200, workspace);
    await tester(auth.test, bundle({}, {}, { baseUrl: 'https://dev.example.com' }) as never);
    assert.ok(scope.isDone());
  });
});
