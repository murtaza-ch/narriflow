import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import nock from 'nock';
import { api, apiError, bundle, clip, event, eventsPage, hydrate, narriflow, operationFinished, pointer, project, run, uuid, zapierError } from './helpers';

before(() => nock.disableNetConnect());
afterEach(() => {
  assert.deepEqual(nock.pendingMocks(), [], 'every mocked request was made');
  nock.cleanAll();
});

const EVENTS = api('/events');
/** Every trigger asks for the newest page of its types, once. */
const feed = (types: string) => ({ types, order: 'desc', limit: '100' });
const opFeed = feed('operation.finished');

describe('Clips Ready', () => {
  it('keeps finished generations, newest first, and defers the reads behind a dehydrated details field', async () => {
    const older = operationFinished('generation', 'completed', uuid(4), 'op_AAAAAAAAAAAAAAAAAAAAAAA');
    const newer = operationFinished('generation', 'partial', uuid(5), 'op_BBBBBBBBBBBBBBBBBBBBBBB');
    const ignored = [
      operationFinished('intake', 'completed'),
      operationFinished('generation', 'failed'),
      operationFinished('generation', 'cancelled'),
      operationFinished('export', 'completed'),
      operationFinished('intake', 'completed', null),
    ];
    // No project or clip is mocked: the poll makes the one feed request and nothing else.
    narriflow().get(EVENTS).query(opFeed).reply(200, eventsPage([older, ignored[0]!, ignored[1]!, newer, ignored[2]!, ignored[3]!, ignored[4]!]));

    const items = await run('triggers', 'clips_ready', bundle());

    assert.deepEqual(items.map((item: any) => item.id), [newer.id, older.id]);
    assert.equal(items[0].projectId, uuid(5));
    assert.equal(items[0].state, 'partial');
    assert.equal(items[0].operationId, 'op_BBBBBBBBBBBBBBBBBBBBBBB');
    assert.deepEqual(pointer(items[0].details), { method: 'hydrators.hydrateClipsReady', input: { projectId: uuid(5) } });
    assert.deepEqual(pointer(items[1].details).input, { projectId: uuid(4) });
  });

  it('hydrates an event with the project title and its top clips only when Zapier asks', async () => {
    narriflow().get(api(`/projects/${uuid(4)}`)).reply(200, project(uuid(4), 'Episode 41'));
    narriflow().get(api(`/projects/${uuid(4)}/clips`)).query({ limit: '10' }).reply(200, { items: [clip(10, 'Launch week two', 1, uuid(4)), clip(11, null, 1, uuid(4))], nextCursor: null });
    const details = await hydrate('hydrateClipsReady', { projectId: uuid(4) });
    assert.equal(details.available, true);
    assert.equal(details.projectTitle, 'Episode 41');
    assert.equal(details.reviewUrl, `https://app.narriflow.com/projects/${uuid(4)}`);
    assert.equal(details.topClipId, uuid(10));
    assert.equal(details.clipTitles, '1. Launch week two\n2. Untitled clip');
    assert.equal(details.clipCount, 2);
    assert.equal(details.clips[0].viralityScore, 80);
  });

  it('marks details unavailable for a project that was deleted', async () => {
    narriflow().get(api(`/projects/${uuid(4)}`)).reply(404, apiError('project_not_found', 'This project doesn\'t exist.'));
    narriflow().get(api(`/projects/${uuid(4)}/clips`)).query({ limit: '10' }).reply(404, apiError('project_not_found', 'This project doesn\'t exist.'));
    assert.deepEqual(await hydrate('hydrateClipsReady', { projectId: uuid(4) }), { available: false });
  });

  it('returns the same IDs on every poll, so Zapier\'s deduplication delivers each event once', async () => {
    const finished = operationFinished('generation', 'completed');
    for (let poll = 0; poll < 2; poll++) narriflow().get(EVENTS).query(opFeed).reply(200, eventsPage([finished]));
    const first = await run('triggers', 'clips_ready', bundle());
    const second = await run('triggers', 'clips_ready', bundle());
    assert.deepEqual(first.map((item: any) => item.id), [finished.id]);
    assert.deepEqual(second.map((item: any) => item.id), [finished.id]);
  });

  it('makes one request however busy the Workspace is', async () => {
    const busy = Array.from({ length: 97 }, (_, index) => operationFinished(index % 2 === 0 ? 'intake' : 'export', 'completed'));
    const generations = [operationFinished('generation', 'completed'), operationFinished('generation', 'completed', uuid(5)), operationFinished('generation', 'partial', uuid(6))];
    narriflow().get(EVENTS).query(opFeed).reply(200, eventsPage([...busy.slice(0, 40), generations[0]!, ...busy.slice(40, 80), generations[1]!, ...busy.slice(80), generations[2]!]));
    const items = await run('triggers', 'clips_ready', bundle());
    assert.deepEqual(items.map((item: any) => item.id), [generations[2]!.id, generations[1]!.id, generations[0]!.id]);
  });

  it('returns three events while the Zap editor loads a sample', async () => {
    const events = Array.from({ length: 5 }, () => operationFinished('generation', 'completed'));
    narriflow().get(EVENTS).query(opFeed).reply(200, eventsPage(events));
    const items = await run('triggers', 'clips_ready', bundle({}, { isLoadingSample: true }));
    assert.deepEqual(items.map((item: any) => item.id), [...events].reverse().slice(0, 3).map((item) => item.id));
  });

  it('refuses a deployment that ignores newest-first order instead of serving its oldest events', async () => {
    const oldestFirst = [operationFinished('generation', 'completed'), operationFinished('generation', 'completed')];
    narriflow().get(EVENTS).query(opFeed).reply(200, { data: oldestFirst, nextCursor: String(oldestFirst[1]!.seq) });
    await assert.rejects(run('triggers', 'clips_ready', bundle()), (err) => {
      assert.equal(zapierError(err).code, 'events_order_unsupported');
      return true;
    });
  });
});

describe('Export Finished', () => {
  const exportOperation = (operationId: string, state = 'completed') => ({
    operationId,
    kind: 'export',
    state,
    stage: null,
    progress: 1,
    items: [
      { kind: 'variant', id: uuid(80), state: 'completed', failureCode: null },
      { kind: 'variant', id: uuid(81), state: state === 'partial' ? 'failed' : 'completed', failureCode: null },
    ],
    results: { projectId: uuid(4), clipIds: [uuid(10)], exportId: uuid(20) },
    notices: [],
    failureCode: null,
    reviewUrl: `https://app.narriflow.com/projects/${uuid(4)}`,
    statusUrl: `https://app.narriflow.com/api/v1/operations/${operationId}`,
  });

  it('keeps finished exports and points details at the export operation', async () => {
    const finished = operationFinished('export', 'partial', uuid(4), 'op_EEEEEEEEEEEEEEEEEEEEEEE');
    narriflow().get(EVENTS).query(opFeed).reply(200, eventsPage([operationFinished('generation', 'completed'), finished, operationFinished('export', 'failed')]));
    const items = await run('triggers', 'export_finished', bundle());
    assert.deepEqual(items.map((item: any) => item.id), [finished.id]);
    assert.equal(items[0].state, 'partial');
    assert.deepEqual(pointer(items[0].details), { method: 'hydrators.hydrateExportFinished', input: { operationId: 'op_EEEEEEEEEEEEEEEEEEEEEEE' } });
  });

  it('hydrates the export, clip and format counts with one operation read', async () => {
    narriflow().get(api('/operations/op_EEEEEEEEEEEEEEEEEEEEEEE')).reply(200, exportOperation('op_EEEEEEEEEEEEEEEEEEEEEEE', 'partial'));
    const details = await hydrate('hydrateExportFinished', { operationId: 'op_EEEEEEEEEEEEEEEEEEEEEEE' });
    assert.equal(details.exportId, uuid(20));
    assert.equal(details.clipId, uuid(10));
    assert.equal(details.projectId, uuid(4));
    assert.equal(details.formatCount, 2);
    assert.equal(details.readyFormatCount, 1);
  });

  it('marks details unavailable for an operation that no longer resolves', async () => {
    narriflow().get(api('/operations/op_GGGGGGGGGGGGGGGGGGGGGGG')).reply(404, apiError('operation_not_found', 'Not found.'));
    assert.deepEqual(await hydrate('hydrateExportFinished', { operationId: 'op_GGGGGGGGGGGGGGGGGGGGGGG' }), { available: false });
  });
});

describe('Finishing Ready', () => {
  const subject = (state: string, reason: string | null, exportIds: string[]) => ({ projectId: uuid(4), operation: { kind: 'generation', id: 'op_AAAAAAAAAAAAAAAAAAAAAAA' }, state, reason, exportIds });

  it('fires for ready and partial finishing, not skipped, with the export IDs straight from the event', async () => {
    const ready = event('finishing.finished', subject('ready', null, [uuid(20), uuid(21)]));
    const partial = event('finishing.finished', subject('partial', 'exports_failed', [uuid(22)]));
    const skipped = event('finishing.finished', subject('skipped', 'plan_required', []));
    narriflow().get(EVENTS).query(feed('finishing.finished')).reply(200, eventsPage([ready, skipped, partial]));
    const items = await run('triggers', 'finishing_ready', bundle());
    assert.deepEqual(items.map((item: any) => item.id), [partial.id, ready.id]);
    assert.deepEqual(items[1].exportIds, [uuid(20), uuid(21)]);
    assert.equal(items[1].firstExportId, uuid(20));
    assert.equal(items[1].exportCount, 2);
    assert.equal(items[0].reason, 'exports_failed');
    assert.deepEqual(pointer(items[1].details), { method: 'hydrators.hydrateProject', input: { projectId: uuid(4) } });
  });
});

describe('Autopilot Episode Imported', () => {
  it('returns the rule, episode and project IDs, and hydrates the project title later', async () => {
    const imported = event('autopilot.episode_imported', { ruleId: uuid(30), projectId: uuid(4), episodeId: 'ep-42' });
    narriflow().get(EVENTS).query(feed('autopilot.episode_imported')).reply(200, eventsPage([imported]));
    const [item] = await run('triggers', 'autopilot_episode_imported', bundle());
    assert.equal(item.id, imported.id);
    assert.equal(item.ruleId, uuid(30));
    assert.equal(item.episodeId, 'ep-42');
    assert.deepEqual(pointer(item.details).input, { projectId: uuid(4) });

    narriflow().get(api(`/projects/${uuid(4)}`)).reply(200, project(uuid(4), 'Episode 42'));
    const details = await hydrate('hydrateProject', { projectId: uuid(4) });
    assert.equal(details.projectTitle, 'Episode 42');
    assert.equal(details.available, true);
  });
});

describe('Post Published and Post Needs Attention', () => {
  const post = (state: string, clipId: string | null = uuid(10)) =>
    event('social_post.finished', { socialPostId: uuid(40), projectId: uuid(4), clipId, platform: 'tiktok', state });
  const postFeed = feed('social_post.finished');

  it('Post Published fires only for posted', async () => {
    const posted = post('posted');
    narriflow().get(EVENTS).query(postFeed).reply(200, eventsPage([post('failed'), posted, post('sent_to_inbox'), post('needs_attention')]));
    const items = await run('triggers', 'post_published', bundle());
    assert.deepEqual(items.map((item: any) => item.id), [posted.id]);
    assert.equal(items[0].platformName, 'TikTok');
    assert.equal(items[0].clipId, uuid(10));
    assert.deepEqual(pointer(items[0].details), { method: 'hydrators.hydratePostClip', input: { clipId: uuid(10) } });
  });

  it('Post Needs Attention fires for needs_attention and failed', async () => {
    const attention = post('needs_attention');
    const failed = post('failed');
    narriflow().get(EVENTS).query(postFeed).reply(200, eventsPage([attention, post('posted'), failed]));
    const items = await run('triggers', 'post_needs_attention', bundle());
    assert.deepEqual(items.map((item: any) => item.id), [failed.id, attention.id]);
    assert.deepEqual(items.map((item: any) => item.state), ['failed', 'needs_attention']);
  });

  it('hydrates the clip title, and still delivers a post whose clip is gone or never had one', async () => {
    narriflow().get(api(`/clips/${uuid(10)}`)).reply(200, { clip: clip(10, 'Launch week two') });
    assert.deepEqual(await hydrate('hydratePostClip', { clipId: uuid(10) }), {
      available: true,
      clipTitle: 'Launch week two',
      clipReviewUrl: `https://app.narriflow.com/projects/${uuid(4)}/clips/${uuid(10)}`,
    });
    narriflow().get(api(`/clips/${uuid(11)}`)).reply(404, apiError('clip_not_found', 'Not found.'));
    assert.deepEqual(await hydrate('hydratePostClip', { clipId: uuid(11) }), { available: false });
    assert.deepEqual(await hydrate('hydratePostClip', { clipId: null }), { available: false });
  });

  it('tells the person which permission a key without publishing:read is missing', async () => {
    for (const key of ['post_published', 'post_needs_attention']) {
      narriflow()
        .get(EVENTS)
        .query(postFeed)
        .reply(403, apiError('scope_required', 'This credential requires the publishing:read scope', { details: { scope: 'publishing:read' } }));
      await assert.rejects(run('triggers', key, bundle()), (err) => {
        const shown = zapierError(err);
        assert.equal(shown.code, 'scope_required');
        assert.equal(shown.status, 403);
        assert.match(shown.message, /does not have the publishing:read permission/);
        assert.match(shown.message, /Developer access/);
        return true;
      });
    }
  });
});

describe('dropdown triggers', () => {
  it('lists Brand Profiles, marking the default', async () => {
    narriflow().get(api('/brand-profiles')).reply(200, {
      profiles: [
        { brandProfileId: uuid(50), name: 'Acme', isDefault: true, defaultStyle: null },
        { brandProfileId: uuid(51), name: 'Side project', isDefault: false, defaultStyle: null },
      ],
    });
    const items = await run('triggers', 'brand_profile_list', bundle());
    assert.deepEqual(items, [
      { id: uuid(50), name: 'Acme (default)' },
      { id: uuid(51), name: 'Side project' },
    ]);
  });

  it('lists only active social accounts, with their platform', async () => {
    narriflow().get(api('/social-accounts')).reply(200, {
      timeZone: 'UTC',
      accounts: [
        { accountId: uuid(60), platform: 'tiktok', displayName: 'Acme Shorts', handle: '@acme', status: 'active', postingSchedule: null },
        { accountId: uuid(61), platform: 'youtube_shorts', displayName: 'Acme YT', handle: null, status: 'expired', postingSchedule: null },
      ],
    });
    const items = await run('triggers', 'social_account_list', bundle());
    assert.deepEqual(items, [{ id: uuid(60), name: 'Acme Shorts (TikTok)' }]);
  });
});
