import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import nock from 'nock';
import App from '../src';
import { idempotencyKey } from '../src/idempotency';
import { api, apiError, bundle, clip, narriflow, run, uuid, zapierError } from './helpers';

before(() => nock.disableNetConnect());
afterEach(() => {
  assert.deepEqual(nock.pendingMocks(), [], 'every mocked request was made');
  nock.cleanAll();
});

const accepted = (kind: 'intake' | 'generation', operationId: string) => ({
  projectId: uuid(4),
  operation: { operationId, kind, statusUrl: `https://app.narriflow.com/api/v1/operations/${operationId}` },
  reviewUrl: `https://app.narriflow.com/projects/${uuid(4)}`,
  callback: null,
});

/** Mocks one POST and records the Idempotency-Key header and body it received. */
function post(path: string, status: number, reply: unknown, headers: Record<string, string> = {}) {
  const seen: Array<{ key: string | undefined; body: any }> = [];
  narriflow()
    .post(api(path))
    .reply(async (request: Request) => {
      const text = await request.text();
      seen.push({ key: request.headers.get('idempotency-key') ?? undefined, body: text ? JSON.parse(text) : undefined });
      return [status, reply as object, headers];
    });
  return seen;
}

describe('Submit Video Link', () => {
  const input = { url: ' https://www.youtube.com/watch?v=abc ', title: 'Episode 42', brandProfileId: uuid(50), clipCountTarget: '8', clipLengthPreset: '30_to_60s', specificMoments: '', finishingTopClips: '3', finishingCopyPlatforms: ['tiktok'] };

  it('posts the link with committed generation and finishing settings', async () => {
    const seen = post('/projects', 202, accepted('intake', 'op_CCCCCCCCCCCCCCCCCCCCCCC'));
    const result = await run('creates', 'submit_video_link', bundle(input));
    assert.deepEqual(seen[0]!.body, {
      url: 'https://www.youtube.com/watch?v=abc',
      title: 'Episode 42',
      brandProfileId: uuid(50),
      generation: { clipCountTarget: 8, clipLengthPreset: '30_to_60s' },
      finishing: { topClips: 3, copyPlatforms: ['tiktok'], delivery: 'ready_to_review' },
    });
    assert.equal(result.id, uuid(4));
    assert.equal(result.operationId, 'op_CCCCCCCCCCCCCCCCCCCCCCC');
    assert.equal(result.operationKind, 'intake');
    assert.equal(result.replayed, false);
  });

  it('sends only the link when nothing else is set', async () => {
    const seen = post('/projects', 202, accepted('intake', 'op_CCCCCCCCCCCCCCCCCCCCCCC'));
    await run('creates', 'submit_video_link', bundle({ url: 'https://youtu.be/abc' }));
    assert.deepEqual(seen[0]!.body, { url: 'https://youtu.be/abc' });
  });

  it('derives the Idempotency-Key from the step\'s inputs, so a retry repeats it and reports the replay', async () => {
    const first = post('/projects', 202, accepted('intake', 'op_CCCCCCCCCCCCCCCCCCCCCCC'));
    await run('creates', 'submit_video_link', bundle(input));
    const retry = post('/projects', 202, accepted('intake', 'op_CCCCCCCCCCCCCCCCCCCCCCC'), { 'Idempotent-Replayed': 'true' });
    const replay = await run('creates', 'submit_video_link', bundle(input));
    assert.equal(first[0]!.key, retry[0]!.key);
    assert.equal(first[0]!.key, idempotencyKey('submit-video-link', first[0]!.body));
    assert.equal(replay.replayed, true);
  });

  it('uses another key when an input changes', async () => {
    const a = post('/projects', 202, accepted('intake', 'op_CCCCCCCCCCCCCCCCCCCCCCC'));
    await run('creates', 'submit_video_link', bundle(input));
    const b = post('/projects', 202, accepted('intake', 'op_CCCCCCCCCCCCCCCCCCCCCCC'));
    await run('creates', 'submit_video_link', bundle({ ...input, clipCountTarget: '9' }));
    assert.notEqual(a[0]!.key, b[0]!.key);
  });

  it('refuses finishing options without Top Clips before calling the API', async () => {
    await assert.rejects(run('creates', 'submit_video_link', bundle({ url: 'https://youtu.be/abc', finishingMinScore: '70' })), (err) => {
      assert.match(zapierError(err).message, /Top Clips/);
      return true;
    });
    await assert.rejects(run('creates', 'submit_video_link', bundle({ url: 'https://youtu.be/abc', clipCountTarget: 'many' })), (err) => {
      assert.match(zapierError(err).message, /whole number/);
      return true;
    });
  });

  it('shows Narriflow\'s message and request reference when the quota is used up', async () => {
    post('/projects', 402, apiError('processing_minutes_exhausted', 'This Workspace has used its processing minutes.'));
    await assert.rejects(run('creates', 'submit_video_link', bundle({ url: 'https://youtu.be/abc' })), (err) => {
      const shown = zapierError(err);
      assert.equal(shown.code, 'processing_minutes_exhausted');
      assert.equal(shown.status, 402);
      assert.match(shown.message, /processing minutes.*req_test/);
      return true;
    });
  });
});

describe('Generate Clips', () => {
  it('posts to the project\'s generations with its own key', async () => {
    const seen = post(`/projects/${uuid(4)}/generations`, 202, accepted('generation', 'op_AAAAAAAAAAAAAAAAAAAAAAA'));
    const result = await run('creates', 'generate_clips', bundle({ projectId: uuid(4), forceRegenerate: true, clipCountTarget: 5 }));
    assert.deepEqual(seen[0]!.body, { generation: { clipCountTarget: 5 }, forceRegenerate: true });
    assert.equal(seen[0]!.key, idempotencyKey('generate-clips', { projectId: uuid(4), ...seen[0]!.body }));
    assert.equal(result.operationKind, 'generation');
  });

  it('defaults to not regenerating', async () => {
    const seen = post(`/projects/${uuid(4)}/generations`, 202, accepted('generation', 'op_AAAAAAAAAAAAAAAAAAAAAAA'));
    await run('creates', 'generate_clips', bundle({ projectId: uuid(4) }));
    assert.deepEqual(seen[0]!.body, { forceRegenerate: false });
  });
});

describe('Export Clip', () => {
  const created = (revision: number) => ({
    export: { exportId: uuid(20), projectId: uuid(4), clipId: uuid(10), editorRevision: revision, status: 'queued', reviewUrl: 'https://app.narriflow.com/x' },
    reused: false,
    output: { requested: { resolution: '1080p' }, granted: { resolution: '720p', watermark: true }, reason: 'plan_limit' },
    operation: { operationId: 'op_BBBBBBBBBBBBBBBBBBBBBBB', kind: 'export', statusUrl: 'https://app.narriflow.com/api/v1/operations/op_BBBBBBBBBBBBBBBBBBBBBBB' },
    callback: null,
  });

  it('reads the clip\'s current revision, then exports exactly that revision', async () => {
    narriflow().get(api(`/clips/${uuid(10)}`)).reply(200, { clip: clip(10, 'Launch week two', 7) });
    const seen = post(`/clips/${uuid(10)}/exports`, 202, created(7));
    const result = await run('creates', 'export_clip', bundle({ clipId: uuid(10), aspectRatios: ['16:9', '9:16'], resolution: '1080p' }));
    assert.deepEqual(seen[0]!.body, { expectedRevision: 7, aspectRatios: ['9:16', '16:9'], resolution: '1080p' });
    assert.equal(result.exportId, uuid(20));
    assert.equal(result.grantedResolution, '720p');
    assert.equal(result.watermark, true);
  });

  it('exports 9:16 at 1080p by default', async () => {
    narriflow().get(api(`/clips/${uuid(10)}`)).reply(200, { clip: clip(10, 'Launch week two', 1) });
    const seen = post(`/clips/${uuid(10)}/exports`, 202, created(1));
    await run('creates', 'export_clip', bundle({ clipId: uuid(10) }));
    assert.deepEqual(seen[0]!.body, { expectedRevision: 1, aspectRatios: ['9:16'], resolution: '1080p' });
  });

  it('repeats the key for the same clip revision and formats in any order, and changes it for a new revision', async () => {
    const keys: Array<string | undefined> = [];
    for (const [revision, ratios] of [[3, ['9:16', '1:1']], [3, ['1:1', '9:16']], [4, ['9:16', '1:1']]] as const) {
      narriflow().get(api(`/clips/${uuid(10)}`)).reply(200, { clip: clip(10, 'Launch week two', revision) });
      const seen = post(`/clips/${uuid(10)}/exports`, 202, created(revision));
      await run('creates', 'export_clip', bundle({ clipId: uuid(10), aspectRatios: [...ratios] }));
      keys.push(seen[0]!.key);
    }
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
  });

  it('shows the API\'s message for a clip that is not in the Workspace', async () => {
    narriflow().get(api(`/clips/${uuid(10)}`)).reply(404, apiError('clip_not_found', 'This clip doesn\'t exist in the key\'s workspace.'));
    await assert.rejects(run('creates', 'export_clip', bundle({ clipId: uuid(10) })), (err) => {
      assert.equal(zapierError(err).code, 'clip_not_found');
      return true;
    });
  });
});

describe('Propose Social Post', () => {
  const proposal = (replayed = false) => ({
    proposal: {
      proposalId: uuid(70), projectId: uuid(4), clipId: uuid(10), socialAccountId: uuid(60), platform: 'tiktok', caption: 'Nobody tells you.',
      source: 'integration', exportId: uuid(20), exportVariantId: uuid(80), aspectRatio: '9:16', createdAt: '2026-10-24T12:00:00.000Z',
    },
    queueUrl: 'https://app.narriflow.com/calendar/queue',
    replayed,
  });
  const input = { clipId: uuid(10), exportId: uuid(20), socialAccountId: uuid(60), caption: ' Nobody tells you. ' };

  it('proposes the post and returns where a person accepts it', async () => {
    const seen = post('/social-posts/proposals', 201, proposal());
    const result = await run('creates', 'propose_social_post', bundle(input));
    assert.deepEqual(seen[0]!.body, { clipId: uuid(10), exportId: uuid(20), socialAccountId: uuid(60), caption: 'Nobody tells you.' });
    assert.equal(seen[0]!.key, idempotencyKey('propose-social-post', seen[0]!.body));
    assert.equal(result.id, uuid(70));
    assert.equal(result.queueUrl, 'https://app.narriflow.com/calendar/queue');
  });

  it('leaves the caption out to use Narriflow\'s latest copy', async () => {
    const seen = post('/social-posts/proposals', 201, proposal());
    await run('creates', 'propose_social_post', bundle({ ...input, caption: '' }));
    assert.deepEqual(seen[0]!.body, { clipId: uuid(10), exportId: uuid(20), socialAccountId: uuid(60) });
  });

  it('reports a replay from the API\'s own flag', async () => {
    post('/social-posts/proposals', 201, proposal(true));
    assert.equal((await run('creates', 'propose_social_post', bundle(input))).replayed, true);
  });

  it('shows why an export cannot be proposed', async () => {
    post('/social-posts/proposals', 409, apiError('export_not_ready', 'This export is still rendering.'));
    await assert.rejects(run('creates', 'propose_social_post', bundle(input)), (err) => {
      assert.match(zapierError(err).message, /still rendering/);
      return true;
    });
  });
});

describe('Run Key', () => {
  const fields = (key: string) =>
    (App as unknown as { creates: Record<string, { operation: { inputFields: Array<{ key: string; helpText?: string }> } }> }).creates[key]!.operation.inputFields;

  it('is an optional input of every action, with the same help text', () => {
    for (const key of ['submit_video_link', 'generate_clips', 'export_clip', 'propose_social_post']) {
      const field = fields(key).find((entry) => entry.key === 'runKey');
      assert.equal(field?.helpText, "Map the trigger's Event ID so each event runs once.", key);
    }
  });

  it('says on Generate Again that identical settings are a permanent replay', () => {
    const field = fields('generate_clips').find((entry) => entry.key === 'forceRegenerate');
    assert.match(field?.helpText ?? '', /permanent replay/);
  });

  it('Submit Video Link: the same link runs once per Run Key, and the Run Key is not sent to the API', async () => {
    const keys: Array<string | undefined> = [];
    const bodies: unknown[] = [];
    for (const runKey of ['event-a', 'event-a', 'event-b', undefined]) {
      const seen = post('/projects', 202, accepted('intake', 'op_CCCCCCCCCCCCCCCCCCCCCCC'));
      await run('creates', 'submit_video_link', bundle({ url: 'https://youtu.be/abc', runKey }));
      keys.push(seen[0]!.key);
      bodies.push(seen[0]!.body);
    }
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    assert.notEqual(keys[0], keys[3]);
    assert.equal(keys[3], idempotencyKey('submit-video-link', { url: 'https://youtu.be/abc' }));
    assert.equal(keys[0], idempotencyKey('submit-video-link', { url: 'https://youtu.be/abc' }, 'event-a'));
    for (const body of bodies) assert.deepEqual(body, { url: 'https://youtu.be/abc' });
  });

  it('Generate Clips: Generate Again runs again under a new Run Key', async () => {
    const keys: Array<string | undefined> = [];
    for (const runKey of ['event-a', 'event-b']) {
      const seen = post(`/projects/${uuid(4)}/generations`, 202, accepted('generation', 'op_AAAAAAAAAAAAAAAAAAAAAAA'));
      await run('creates', 'generate_clips', bundle({ projectId: uuid(4), forceRegenerate: true, runKey }));
      keys.push(seen[0]!.key);
      assert.deepEqual(seen[0]!.body, { forceRegenerate: true });
    }
    assert.notEqual(keys[0], keys[1]);
  });

  it('Export Clip and Propose Social Post key on the Run Key too', async () => {
    const exportKeys: Array<string | undefined> = [];
    for (const runKey of ['event-a', 'event-b']) {
      narriflow().get(api(`/clips/${uuid(10)}`)).reply(200, { clip: clip(10, 'Launch week two', 2) });
      const seen = post(`/clips/${uuid(10)}/exports`, 202, {
        export: { exportId: uuid(20), projectId: uuid(4), clipId: uuid(10), editorRevision: 2, status: 'queued', reviewUrl: 'https://app.narriflow.com/x' },
        reused: false,
        output: { requested: { resolution: '1080p' }, granted: { resolution: '1080p', watermark: false }, reason: null },
        operation: { operationId: 'op_BBBBBBBBBBBBBBBBBBBBBBB', kind: 'export', statusUrl: 'https://app.narriflow.com/api/v1/operations/op_BBBBBBBBBBBBBBBBBBBBBBB' },
        callback: null,
      });
      await run('creates', 'export_clip', bundle({ clipId: uuid(10), runKey }));
      exportKeys.push(seen[0]!.key);
      assert.deepEqual(seen[0]!.body, { expectedRevision: 2, aspectRatios: ['9:16'], resolution: '1080p' });
    }
    assert.notEqual(exportKeys[0], exportKeys[1]);

    const proposalKeys: Array<string | undefined> = [];
    for (const runKey of ['event-a', 'event-b']) {
      const seen = post('/social-posts/proposals', 201, {
        proposal: { proposalId: uuid(70), projectId: uuid(4), clipId: uuid(10), socialAccountId: uuid(60), platform: 'tiktok', caption: '', source: 'integration', exportId: uuid(20), exportVariantId: uuid(80), aspectRatio: '9:16', createdAt: '2026-10-24T12:00:00.000Z' },
        queueUrl: 'https://app.narriflow.com/calendar/queue',
        replayed: false,
      });
      await run('creates', 'propose_social_post', bundle({ clipId: uuid(10), exportId: uuid(20), socialAccountId: uuid(60), runKey }));
      proposalKeys.push(seen[0]!.key);
      assert.deepEqual(seen[0]!.body, { clipId: uuid(10), exportId: uuid(20), socialAccountId: uuid(60) });
    }
    assert.notEqual(proposalKeys[0], proposalKeys[1]);
  });
});
