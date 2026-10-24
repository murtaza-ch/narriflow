import type { OperationFinishedSubject } from '../events';
import { hydrateClipsReady } from '../hydrators';
import { eventTrigger } from './event-trigger';

export default eventTrigger<OperationFinishedSubject>({
  key: 'clips_ready',
  noun: 'Clips',
  label: 'Clips Ready',
  description: 'Triggers when Narriflow finishes generating clips for a project, including when some of them failed.',
  types: ['operation.finished'],
  accept: ({ subject }) =>
    subject.operation.kind === 'generation' &&
    subject.projectId !== null &&
    (subject.state === 'completed' || subject.state === 'partial'),
  fields: (subject) => ({ projectId: subject.projectId, operationId: subject.operation.id, state: subject.state }),
  details: { hydrator: hydrateClipsReady, input: (subject) => ({ projectId: subject.projectId }) },
  sample: {
    id: '5b1c3a52-9f0e-4d6a-8c1b-2e7d4f9a0b13',
    eventType: 'operation.finished',
    occurredAt: '2026-10-24T12:00:00.000Z',
    projectId: '00000000-0000-4000-8000-000000000004',
    operationId: 'op_AAAAAAAAAAAAAAAAAAAAAAA',
    state: 'completed',
    details: {
      available: true,
      projectTitle: 'Weekly strategy podcast, episode 42',
      reviewUrl: 'https://app.narriflow.com/projects/00000000-0000-4000-8000-000000000004',
      clipCount: 2,
      topClipId: '00000000-0000-4000-8000-000000000010',
      topClipTitle: 'Why most launches fail in week two',
      clipTitles: '1. Why most launches fail in week two\n2. The hiring mistake nobody talks about',
      clips: [
        {
          clipId: '00000000-0000-4000-8000-000000000010',
          title: 'Why most launches fail in week two',
          hookText: 'Nobody tells you what happens after launch day.',
          viralityScore: 91,
          durationSec: 42,
          reviewUrl: 'https://app.narriflow.com/projects/00000000-0000-4000-8000-000000000004/clips/00000000-0000-4000-8000-000000000010',
        },
      ],
    },
  },
  outputFields: [
    { key: 'projectId', label: 'Project ID' },
    { key: 'operationId', label: 'Operation ID' },
    { key: 'state', label: 'State (completed or partial)' },
    { key: 'details__projectTitle', label: 'Project Title' },
    { key: 'details__reviewUrl', label: 'Review URL' },
    { key: 'details__clipCount', label: 'Clip Count (top 10 listed)', type: 'integer' },
    { key: 'details__topClipId', label: 'Top Clip ID' },
    { key: 'details__topClipTitle', label: 'Top Clip Title' },
    { key: 'details__clipTitles', label: 'Clip Titles (numbered list)' },
    {
      key: 'details__clips',
      label: 'Clips',
      children: [
        { key: 'details__clips__clipId', label: 'Clip ID' },
        { key: 'details__clips__title', label: 'Title' },
        { key: 'details__clips__hookText', label: 'Hook' },
        { key: 'details__clips__viralityScore', label: 'Virality Score', type: 'integer' },
        { key: 'details__clips__durationSec', label: 'Duration (seconds)', type: 'number' },
        { key: 'details__clips__reviewUrl', label: 'Review URL' },
      ],
    },
  ],
});
