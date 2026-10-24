import type { FinishingFinishedSubject } from '../events';
import { hydrateProject } from '../hydrators';
import { eventTrigger } from './event-trigger';

export default eventTrigger<FinishingFinishedSubject>({
  key: 'finishing_ready',
  noun: 'Finished Project',
  label: 'Finishing Ready',
  description:
    'Triggers when Narriflow has exported a project\'s best clips and written their copy, as asked by "Finish Automatically" on Submit Video Link or Generate Clips. Also fires when only some exports finished.',
  types: ['finishing.finished'],
  accept: ({ subject }) => subject.state === 'ready' || subject.state === 'partial',
  // The export IDs are in the event itself, so they need no read.
  fields: (subject) => ({
    projectId: subject.projectId,
    operationId: subject.operation.id,
    state: subject.state,
    reason: subject.reason,
    exportCount: subject.exportIds.length,
    firstExportId: subject.exportIds[0] ?? null,
    exportIds: subject.exportIds,
  }),
  details: { hydrator: hydrateProject, input: (subject) => ({ projectId: subject.projectId }) },
  sample: {
    id: '9e4f6d85-2c3b-4a9d-8f4e-5b0a7c2d3e46',
    eventType: 'finishing.finished',
    occurredAt: '2026-10-24T12:20:00.000Z',
    projectId: '00000000-0000-4000-8000-000000000004',
    operationId: 'op_AAAAAAAAAAAAAAAAAAAAAAA',
    state: 'ready',
    reason: null,
    exportCount: 2,
    firstExportId: '00000000-0000-4000-8000-000000000020',
    exportIds: ['00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000021'],
    details: {
      available: true,
      projectTitle: 'Weekly strategy podcast, episode 42',
      sourceType: 'rss',
      durationSeconds: 3120,
      reviewUrl: 'https://app.narriflow.com/projects/00000000-0000-4000-8000-000000000004',
    },
  },
  outputFields: [
    { key: 'projectId', label: 'Project ID' },
    { key: 'operationId', label: 'Generation Operation ID' },
    { key: 'state', label: 'State (ready or partial)' },
    { key: 'reason', label: 'Reason (when partial)' },
    { key: 'exportCount', label: 'Export Count', type: 'integer' },
    { key: 'firstExportId', label: 'First Export ID' },
    { key: 'exportIds', label: 'Export IDs', list: true },
    { key: 'details__projectTitle', label: 'Project Title' },
    { key: 'details__reviewUrl', label: 'Review URL' },
  ],
});
