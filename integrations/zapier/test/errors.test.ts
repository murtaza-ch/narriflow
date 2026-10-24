import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import nock from 'nock';
import { api, apiError, bundle, narriflow, run, zapierError } from './helpers';

before(() => nock.disableNetConnect());
afterEach(() => {
  assert.deepEqual(nock.pendingMocks(), [], 'every mocked request was made');
  nock.cleanAll();
});

const call = () => run('triggers', 'brand_profile_list', bundle());

describe('error mapping', () => {
  it('429 is a Zapier throttle that waits the Retry-After seconds', async () => {
    narriflow().get(api('/brand-profiles')).reply(429, apiError('rate_limited', 'Too many requests.'), { 'Retry-After': '17' });
    await assert.rejects(call(), (err) => {
      assert.equal((err as Error).name, 'ThrottledError');
      assert.equal(zapierError(err).delay, 17);
      return true;
    });
  });

  it('429 prefers the retryAfterSeconds in the body', async () => {
    narriflow().get(api('/brand-profiles')).reply(429, apiError('rate_limited', 'Too many requests.', { retryAfterSeconds: 9 }), { 'Retry-After': '17' });
    await assert.rejects(call(), (err) => {
      assert.equal(zapierError(err).delay, 9);
      assert.match(zapierError(err).message, /Too many requests/);
      return true;
    });
  });

  it('503 stays a throttle, with the delay Narriflow gave', async () => {
    narriflow().get(api('/brand-profiles')).reply(503, apiError('mutations_unavailable', 'Try again shortly.', { retryAfterSeconds: 30 }));
    await assert.rejects(call(), (err) => {
      assert.equal((err as Error).name, 'ThrottledError');
      assert.equal(zapierError(err).delay, 30);
      return true;
    });
  });

  it('401 is an expired connection, so Zapier asks the person to reconnect', async () => {
    narriflow().get(api('/brand-profiles')).reply(401, apiError('invalid_api_key', 'This API key is missing, invalid or revoked.'));
    await assert.rejects(call(), (err) => {
      assert.equal((err as Error).name, 'ExpiredAuthError');
      assert.match((err as Error).message, /missing, invalid or revoked/);
      assert.match((err as Error).message, /Reconnect Narriflow/);
      return true;
    });
  });

  it('403 scope_required names the missing permission and where to turn it on', async () => {
    narriflow()
      .get(api('/brand-profiles'))
      .reply(403, apiError('scope_required', 'This credential requires the projects:read scope', { details: { scope: 'projects:read' } }));
    await assert.rejects(call(), (err) => {
      const shown = zapierError(err);
      assert.equal(shown.code, 'scope_required');
      assert.equal(shown.status, 403);
      assert.match(shown.message, /does not have the projects:read permission/);
      assert.match(shown.message, /Settings, then Developer access/);
      assert.match(shown.message, /req_test/);
      return true;
    });
  });

  it('403 scope_required without a named scope still shows the API\'s message', async () => {
    narriflow().get(api('/brand-profiles')).reply(403, apiError('scope_required', 'This credential needs another scope.'));
    await assert.rejects(call(), (err) => {
      assert.match(zapierError(err).message, /needs another scope/);
      return true;
    });
  });

  it('any other failure carries the API\'s code, status and request reference', async () => {
    narriflow().get(api('/brand-profiles')).reply(402, apiError('integration_access_unavailable', 'The Workspace needs active Business access.'));
    await assert.rejects(call(), (err) => {
      const shown = zapierError(err);
      assert.equal(shown.code, 'integration_access_unavailable');
      assert.equal(shown.status, 402);
      assert.match(shown.message, /Business access.*req_test/);
      return true;
    });
  });
});
