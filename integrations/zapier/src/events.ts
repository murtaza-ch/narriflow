import type { Bundle, ZObject } from 'zapier-platform-core';
import { api } from './api';

/** The Workspace Events this app reads. Subjects carry IDs only. */
export interface WorkspaceEvent<Subject> {
  id: string;
  seq: number;
  type: string;
  version: number;
  occurredAt: string;
  subject: Subject;
}

export interface OperationFinishedSubject {
  operation: { kind: 'intake' | 'generation' | 'export'; id: string };
  projectId: string | null;
  state: 'completed' | 'partial' | 'failed' | 'cancelled';
}

export interface FinishingFinishedSubject {
  projectId: string;
  operation: { kind: 'generation'; id: string };
  state: 'ready' | 'partial' | 'skipped';
  reason: string | null;
  exportIds: string[];
}

export interface AutopilotEpisodeImportedSubject {
  ruleId: string;
  projectId: string;
  episodeId: string;
}

export interface SocialPostFinishedSubject {
  socialPostId: string;
  projectId: string;
  clipId: string | null;
  platform: string;
  state: 'posted' | 'sent_to_inbox' | 'failed' | 'needs_attention';
}

interface EventsPage<Subject> {
  data: WorkspaceEvent<Subject>[];
  nextCursor: string;
}

/** One page, newest first. A busy Workspace's older events are ones Zapier has already seen. */
const FEED_LIMIT = 100;
const SAMPLE_LIMIT = 3;

/**
 * The newest events of the given types that `accept` keeps, newest first.
 *
 * Zapier gives a poll no memory, so each poll asks for the newest page of the
 * feed (`order=desc`) and Zapier's own deduplication, by event ID, delivers each
 * event once. That is one request, however many events the Workspace has.
 */
export async function recentEvents<Subject>(
  z: ZObject,
  bundle: Bundle,
  types: readonly string[],
  accept: (event: WorkspaceEvent<Subject>) => boolean,
): Promise<WorkspaceEvent<Subject>[]> {
  const { data: page } = await api<EventsPage<Subject>>(z, bundle, {
    path: '/events',
    query: { types: types.join(','), order: 'desc', limit: FEED_LIMIT },
  });
  // A deployment that predates `order` ignores it and answers oldest first,
  // which would quietly hand Zaps the Workspace's oldest events.
  const newest = page.data[0];
  const oldest = page.data[page.data.length - 1];
  if (newest && oldest && newest.seq < oldest.seq) {
    throw new z.errors.Error(
      'This Narriflow deployment is older than the Zapier app expects: its event feed ignored the newest-first order. Update the deployment, or reconnect to the production URL.',
      'events_order_unsupported',
      501,
    );
  }
  const accepted = page.data.filter(accept);
  return bundle.meta?.isLoadingSample ? accepted.slice(0, SAMPLE_LIMIT) : accepted;
}
