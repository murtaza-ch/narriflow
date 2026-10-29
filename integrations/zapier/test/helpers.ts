import { randomUUID } from 'node:crypto';
import nock from 'nock';
import zapier from 'zapier-platform-core';
import App from '../src';

export const BASE = 'http://localhost:4000';
export const API_KEY = 'nf_test_key';
const API = '/api/v1';

const tester = zapier.createAppTester(App);

/** Runs one of the app's hydrators, which Zapier calls for an event it has not delivered yet. */
export function hydrate(name: string, inputData: Record<string, unknown>) {
  const hydrator = (App as unknown as { hydrators: Record<string, unknown> }).hydrators[name];
  if (!hydrator) throw new Error(`No hydrator named ${name}`);
  return tester(hydrator as never, bundle(inputData) as never) as Promise<any>;
}

/** What a dehydrated field points at: the hydrator's path in the app and the input it was given. */
export function pointer(dehydrated: string) {
  const match = /^hydrate\|\|\|(.*)\|\|\|hydrate$/s.exec(dehydrated);
  if (!match) throw new Error(`Not a dehydrated field: ${dehydrated}`);
  const payload = JSON.parse(match[1] as string) as { method: string; bundle: Record<string, unknown> };
  return { method: payload.method, input: payload.bundle };
}

type Meta = Record<string, boolean | number | string>;

export function bundle(inputData: Record<string, unknown> = {}, meta: Meta = {}, authData: Record<string, string> = {}) {
  return { authData: { apiKey: API_KEY, baseUrl: BASE, ...authData }, inputData, meta };
}

type Section = 'triggers' | 'creates' | 'searches';

/** Runs a trigger, action or search `perform` through Zapier's own app tester. */
export function run(section: Section, key: string, input: ReturnType<typeof bundle>) {
  const operation = (App as unknown as Record<Section, Record<string, { operation: { perform: unknown } }>>)[section][key]?.operation;
  if (!operation) throw new Error(`No ${section} entry named ${key}`);
  return tester(operation.perform as never, input as never) as Promise<any>;
}

export function api(path: string) {
  return `${API}${path}`;
}

/** An authenticated nock scope for the API origin. */
export function narriflow() {
  return nock(BASE, { reqheaders: { authorization: `Bearer ${API_KEY}`, accept: 'application/json' } });
}

export function uuid(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

let nextSeq = 1;

export function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

export function event<Subject>(type: string, subject: Subject, occurredAt = hoursAgo(1)) {
  return { id: randomUUID(), seq: nextSeq++, type, version: 1, occurredAt, subject };
}

/** The newest-first page `GET /events?order=desc` answers with: highest seq first, nextCursor the highest seq. */
export function eventsPage<Subject>(events: Array<ReturnType<typeof event<Subject>>>) {
  const data = [...events].sort((a, b) => b.seq - a.seq);
  return { data, nextCursor: String(data[0]?.seq ?? 0) };
}

export function operationFinished(kind: 'intake' | 'generation' | 'export', state: string, projectId: string | null = uuid(4), operationId = 'op_AAAAAAAAAAAAAAAAAAAAAAA', occurredAt?: string) {
  return event('operation.finished', { operation: { kind, id: operationId }, projectId, state }, occurredAt);
}

export function project(id = uuid(4), title = 'Weekly strategy podcast') {
  return {
    project: {
      projectId: id,
      workspaceId: uuid(1),
      title,
      sourceType: 'rss',
      ingestStatus: 'ready',
      durationSeconds: 3120,
      languageCode: 'en',
      createdAt: '2026-10-24T09:00:00.000Z',
      reviewUrl: `https://app.narriflow.com/projects/${id}`,
    },
    progress: null,
  };
}

export function clip(id: number, title: string | null, revision = 1, projectId = uuid(4)) {
  return {
    clipId: uuid(id),
    projectId,
    editorRevision: revision,
    title,
    hookText: `Hook ${id}`,
    startSec: 10,
    endSec: 50,
    durationSec: 40,
    scores: { virality: 90 - id },
    reviewUrl: `https://app.narriflow.com/projects/${projectId}/clips/${uuid(id)}`,
  };
}

export function apiError(error: string, message: string, extra: Record<string, unknown> = {}) {
  return { error, message, requestId: 'req_test', ...extra };
}

/** The message and code Zapier surfaces for an error the app threw. */
export function zapierError(err: unknown) {
  const raw = (err as Error).message;
  try {
    return JSON.parse(raw) as { message: string; code?: string; status?: number; delay?: number };
  } catch {
    return { message: raw };
  }
}
