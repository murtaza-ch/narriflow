import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { idempotencyKey } from '../src/idempotency';

// The API accepts 1 to 200 characters from A-Z a-z 0-9 . _ ~ : -
const PATTERN = /^[A-Za-z0-9._~:-]{1,200}$/;

describe('idempotencyKey', () => {
  it('is a valid Idempotency-Key', () => {
    assert.match(idempotencyKey('submit-video-link', { url: 'https://youtu.be/x?t=1&a=ü' }), PATTERN);
  });

  it('is the same for the same inputs, whatever their order or empty fields', () => {
    const a = idempotencyKey('export-clip', { clipId: 'c', aspectRatios: ['9:16'], resolution: '1080p' });
    const b = idempotencyKey('export-clip', { resolution: '1080p', note: '', skipped: undefined, empty: null, aspectRatios: ['9:16'], clipId: 'c' });
    assert.equal(a, b);
  });

  it('is stable across runs, so a Zapier retry on a new process repeats the request', () => {
    assert.equal(
      idempotencyKey('export-clip', { clipId: 'c' }),
      'zapier:export-clip:ad22685958d5e15fe54767fdaca266b7b3cd9ad744ec88376b8aa04d67a71c33',
    );
  });

  it('changes with the action and with any input', () => {
    const base = idempotencyKey('export-clip', { clipId: 'c', resolution: '1080p' });
    assert.notEqual(base, idempotencyKey('generate-clips', { clipId: 'c', resolution: '1080p' }));
    assert.notEqual(base, idempotencyKey('export-clip', { clipId: 'c', resolution: '720p' }));
    assert.notEqual(base, idempotencyKey('export-clip', { clipId: 'd', resolution: '1080p' }));
  });

  it('adds the Run Key to the digest, so the same inputs run once per Run Key', () => {
    const inputs = { url: 'https://example.com/v' };
    const keyA = idempotencyKey('submit-video-link', inputs, 'event-a');
    assert.equal(keyA, idempotencyKey('submit-video-link', inputs, ' event-a '));
    assert.match(keyA, PATTERN);
    assert.notEqual(keyA, idempotencyKey('submit-video-link', inputs, 'event-b'));
    assert.notEqual(keyA, idempotencyKey('submit-video-link', inputs));
    assert.notEqual(keyA, idempotencyKey('submit-video-link', { ...inputs, url: 'https://example.com/w' }, 'event-a'));
  });

  it('keeps the inputs-only key when the Run Key is empty', () => {
    const inputs = { clipId: 'c' };
    const plain = idempotencyKey('export-clip', inputs);
    assert.equal(idempotencyKey('export-clip', inputs, ''), plain);
    assert.equal(idempotencyKey('export-clip', inputs, '   '), plain);
    assert.equal(idempotencyKey('export-clip', inputs, undefined), plain);
  });

  it('never reads the clock or randomness', () => {
    const keys = new Set(Array.from({ length: 5 }, () => idempotencyKey('submit-video-link', { url: 'https://example.com/v' })));
    assert.equal(keys.size, 1);
  });
});
