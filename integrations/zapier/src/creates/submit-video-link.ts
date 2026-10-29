import { defineCreate, defineInputFields, type PlainOutputField } from 'zapier-platform-core';
import { api } from '../api';
import { idempotencyKey, RUN_KEY_FIELD } from '../idempotency';
import type { AcceptedProject } from '../types';
import { FINISHING_FIELDS, GENERATION_FIELDS, finishingSettings, generationSettings, type SettingsInput } from './settings';

interface Input extends SettingsInput {
  url: string;
  title?: string;
  brandProfileId?: string;
  runKey?: string;
}

/** What Submit Video Link and Generate Clips return: the project and the operation to follow. */
export const ACCEPTED_FIELDS: PlainOutputField[] = [
  { key: 'projectId', label: 'Project ID' },
  { key: 'operationId', label: 'Operation ID' },
  { key: 'operationKind', label: 'Operation Kind' },
  { key: 'statusUrl', label: 'Status URL' },
  { key: 'reviewUrl', label: 'Review URL' },
  { key: 'replayed', label: 'Replay of an Earlier Identical Request', type: 'boolean' },
];

export function acceptedItem(accepted: AcceptedProject, replayed: boolean) {
  return {
    id: accepted.projectId,
    projectId: accepted.projectId,
    operationId: accepted.operation.operationId,
    operationKind: accepted.operation.kind,
    statusUrl: accepted.operation.statusUrl,
    reviewUrl: accepted.reviewUrl,
    replayed,
  };
}

const inputFields = defineInputFields([
  {
    key: 'url',
    label: 'Video Link',
    required: true,
    helpText: 'A supported video link, such as a YouTube URL.',
  },
  { key: 'title', label: 'Project Title', helpText: 'Defaults to the video\'s own title.' },
  {
    key: 'brandProfileId',
    label: 'Brand Profile',
    dynamic: 'brand_profile_list.id.name',
    helpText: 'Leave empty to use the Workspace default.',
  },
  ...GENERATION_FIELDS,
  ...FINISHING_FIELDS,
  RUN_KEY_FIELD,
]);

export default defineCreate({
  key: 'submit_video_link',
  noun: 'Project',
  display: {
    label: 'Submit Video Link',
    description: 'Imports a video from a link and generates clips. Uses credits from the Workspace.',
  },
  operation: {
    inputFields,
    perform: async (z, bundle) => {
      const input = bundle.inputData as unknown as Input;
      const body = {
        url: input.url.trim(),
        title: input.title?.trim() || undefined,
        brandProfileId: input.brandProfileId || undefined,
        generation: generationSettings(z, input),
        finishing: finishingSettings(z, input),
      };
      // The same inputs (and Run Key) are the same request, so a retry returns the first project.
      const { data, replayed } = await api<AcceptedProject>(z, bundle, {
        method: 'POST',
        path: '/projects',
        body,
        idempotencyKey: idempotencyKey('submit-video-link', body, input.runKey),
      });
      return acceptedItem(data, replayed);
    },
    sample: {
      id: '00000000-0000-4000-8000-000000000004',
      projectId: '00000000-0000-4000-8000-000000000004',
      operationId: 'op_CCCCCCCCCCCCCCCCCCCCCCC',
      operationKind: 'intake',
      statusUrl: 'http://localhost:4000/api/v1/operations/op_CCCCCCCCCCCCCCCCCCCCCCC',
      reviewUrl: 'https://app.narriflow.com/projects/00000000-0000-4000-8000-000000000004',
      replayed: false,
    },
    outputFields: ACCEPTED_FIELDS,
  },
});
