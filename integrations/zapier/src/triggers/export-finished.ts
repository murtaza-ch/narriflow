import type { OperationFinishedSubject } from '../events';
import { hydrateExportFinished } from '../hydrators';
import { eventTrigger } from './event-trigger';

export default eventTrigger<OperationFinishedSubject>({
  key: 'export_finished',
  noun: 'Export',
  label: 'Export Finished',
  description:
    'Triggers when a clip export has at least one file ready. Pass the Export ID to Get Export Download for fresh download links.',
  types: ['operation.finished'],
  accept: ({ subject }) =>
    subject.operation.kind === 'export' && (subject.state === 'completed' || subject.state === 'partial'),
  fields: (subject) => ({ operationId: subject.operation.id, state: subject.state }),
  details: { hydrator: hydrateExportFinished, input: (subject) => ({ operationId: subject.operation.id }) },
  sample: {
    id: '7c2d4b63-0a1f-4e7b-9d2c-3f8e5a0b1c24',
    eventType: 'operation.finished',
    occurredAt: '2026-10-24T12:05:00.000Z',
    operationId: 'op_BBBBBBBBBBBBBBBBBBBBBBB',
    state: 'completed',
    details: {
      available: true,
      exportId: '00000000-0000-4000-8000-000000000020',
      projectId: '00000000-0000-4000-8000-000000000004',
      clipId: '00000000-0000-4000-8000-000000000010',
      formatCount: 1,
      readyFormatCount: 1,
      reviewUrl: 'https://app.narriflow.com/projects/00000000-0000-4000-8000-000000000004',
    },
  },
  outputFields: [
    { key: 'operationId', label: 'Operation ID' },
    { key: 'state', label: 'State (completed or partial)' },
    { key: 'details__exportId', label: 'Export ID' },
    { key: 'details__projectId', label: 'Project ID' },
    { key: 'details__clipId', label: 'Clip ID' },
    { key: 'details__formatCount', label: 'Formats Requested', type: 'integer' },
    { key: 'details__readyFormatCount', label: 'Formats Ready', type: 'integer' },
    { key: 'details__reviewUrl', label: 'Review URL' },
  ],
});
