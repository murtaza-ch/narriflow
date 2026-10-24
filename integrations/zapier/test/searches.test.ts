import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import nock from 'nock';
import { api, apiError, bundle, narriflow, project, run, uuid, zapierError } from './helpers';

before(() => nock.disableNetConnect());
afterEach(() => {
  assert.deepEqual(nock.pendingMocks(), [], 'every mocked request was made');
  nock.cleanAll();
});

const listed = (id: number, title: string, clipCount = 3) => ({ ...project(uuid(id), title).project, clipCount, progress: {} });

describe('Find Project', () => {
  it('reads one project by ID', async () => {
    narriflow().get(api(`/projects/${uuid(4)}`)).reply(200, project(uuid(4), 'Episode 42'));
    const [found] = await run('searches', 'find_project', bundle({ projectId: ` ${uuid(4)} ` }));
    assert.equal(found.id, uuid(4));
    assert.equal(found.title, 'Episode 42');
  });

  it('returns nothing, not an error, for an ID that does not exist', async () => {
    narriflow().get(api(`/projects/${uuid(9)}`)).reply(404, apiError('project_not_found', 'Not found.'));
    assert.deepEqual(await run('searches', 'find_project', bundle({ projectId: uuid(9) })), []);
  });

  it('finds titles containing the text, ignoring case, across pages', async () => {
    narriflow().get(api('/projects')).query({ limit: '100' }).reply(200, { items: [listed(1, 'Cooking basics'), listed(2, 'Q3 Strategy review')], nextCursor: 'next-page', totalCount: 3 });
    narriflow().get(api('/projects')).query({ limit: '100', cursor: 'next-page' }).reply(200, { items: [listed(3, 'strategy podcast #42')], nextCursor: null, totalCount: 3 });
    const found = await run('searches', 'find_project', bundle({ title: 'STRATEGY' }));
    assert.deepEqual(found.map((item: any) => item.title), ['Q3 Strategy review', 'strategy podcast #42']);
    assert.equal(found[0].clipCount, 3);
  });

  it('returns nothing when no title matches', async () => {
    narriflow().get(api('/projects')).query({ limit: '100' }).reply(200, { items: [listed(1, 'Cooking basics')], nextCursor: null, totalCount: 1 });
    assert.deepEqual(await run('searches', 'find_project', bundle({ title: 'zebra' })), []);
  });

  it('asks for an ID or a title', async () => {
    await assert.rejects(run('searches', 'find_project', bundle({})), (err) => {
      assert.match(zapierError(err).message, /Project ID or part of a title/);
      return true;
    });
  });
});

describe('Get Export Download', () => {
  const grants = {
    exportId: uuid(20),
    projectId: uuid(4),
    clipId: uuid(10),
    editorRevision: 3,
    variants: [
      { variantId: uuid(80), aspectRatio: '9:16', resolution: '1080p', watermark: false, fileName: 'clip-9x16.mp4', sizeBytes: 1000, downloadUrl: 'https://files.example.com/a?sig=1', expiresAt: '2026-10-24T12:15:00.000Z' },
      { variantId: uuid(81), aspectRatio: '1:1', resolution: '1080p', watermark: false, fileName: 'clip-1x1.mp4', sizeBytes: 900, downloadUrl: 'https://files.example.com/b?sig=2', expiresAt: '2026-10-24T12:14:00.000Z' },
    ],
    subtitles: [
      { format: 'srt', fileName: 'clip.srt', content: '1\n00:00:00,000 --> 00:00:01,000\nHi\n' },
      { format: 'vtt', fileName: 'clip.vtt', content: 'WEBVTT\n' },
    ],
  };

  it('returns fresh links for every format, the first one flattened, and says they expire in 15 minutes', async () => {
    narriflow().get(api(`/exports/${uuid(20)}/download`)).reply(200, grants);
    const [result] = await run('searches', 'get_export_download', bundle({ exportId: uuid(20) }));
    assert.equal(result.downloadUrl, 'https://files.example.com/a?sig=1');
    assert.equal(result.fileName, 'clip-9x16.mp4');
    assert.equal(result.files.length, 2);
    assert.equal(result.expiresAt, '2026-10-24T12:14:00.000Z');
    assert.match(result.expiryNote, /expire 15 minutes/);
    assert.match(result.srt, /Hi/);
    assert.equal(result.vtt, 'WEBVTT\n');
  });

  it('asks the API for one format when a Format ID is given', async () => {
    narriflow().get(api(`/exports/${uuid(20)}/download`)).query({ variantId: uuid(81) }).reply(200, { ...grants, variants: [grants.variants[1]] });
    const [result] = await run('searches', 'get_export_download', bundle({ exportId: uuid(20), variantId: uuid(81) }));
    assert.equal(result.aspectRatio, '1:1');
    assert.equal(result.files.length, 1);
  });

  it('returns nothing for an export that does not exist, and shows the API\'s reason for one that is not ready', async () => {
    narriflow().get(api(`/exports/${uuid(21)}/download`)).reply(404, apiError('clip_export_not_found', 'Not found.'));
    assert.deepEqual(await run('searches', 'get_export_download', bundle({ exportId: uuid(21) })), []);
    narriflow().get(api(`/exports/${uuid(22)}/download`)).reply(409, apiError('export_not_ready', 'This export has no finished files yet.'));
    await assert.rejects(run('searches', 'get_export_download', bundle({ exportId: uuid(22) })), (err) => {
      assert.match(zapierError(err).message, /no finished files/);
      return true;
    });
  });
});
