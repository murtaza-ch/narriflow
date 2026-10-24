import { defineCreate, defineInputFields } from 'zapier-platform-core';
import { api } from '../api';
import { idempotencyKey, RUN_KEY_FIELD } from '../idempotency';
import type { AcceptedProject } from '../types';
import { FINISHING_FIELDS, GENERATION_FIELDS, finishingSettings, generationSettings, type SettingsInput } from './settings';
import { ACCEPTED_FIELDS, acceptedItem } from './submit-video-link';

interface Input extends SettingsInput {
  projectId: string;
  forceRegenerate?: boolean;
  runKey?: string;
}

const inputFields = defineInputFields([
  {
    key: 'projectId',
    label: 'Project ID',
    required: true,
    helpText: 'From Submit Video Link, Autopilot Episode Imported or Find Project.',
  },
  {
    key: 'forceRegenerate',
    label: 'Generate Again',
    type: 'boolean',
    helpText:
      'Yes generates new clips even if the project already has some. Narriflow remembers a request for good, so repeating identical settings is a permanent replay of the first run. To run again, change a setting or map a new Run Key.',
  },
  ...GENERATION_FIELDS,
  ...FINISHING_FIELDS,
  RUN_KEY_FIELD,
]);

export default defineCreate({
  key: 'generate_clips',
  noun: 'Clip Generation',
  display: {
    label: 'Generate Clips',
    description: 'Generates clips for an imported project. Uses processing minutes from the Workspace.',
  },
  operation: {
    inputFields,
    perform: async (z, bundle) => {
      const input = bundle.inputData as unknown as Input;
      const projectId = input.projectId.trim();
      const body = {
        generation: generationSettings(z, input),
        finishing: finishingSettings(z, input),
        forceRegenerate: input.forceRegenerate === true || String(input.forceRegenerate).toLowerCase() === 'true',
      };
      const { data, replayed } = await api<AcceptedProject>(z, bundle, {
        method: 'POST',
        path: `/projects/${encodeURIComponent(projectId)}/generations`,
        body,
        idempotencyKey: idempotencyKey('generate-clips', { projectId, ...body }, input.runKey),
      });
      return acceptedItem(data, replayed);
    },
    sample: {
      id: '00000000-0000-4000-8000-000000000004',
      projectId: '00000000-0000-4000-8000-000000000004',
      operationId: 'op_AAAAAAAAAAAAAAAAAAAAAAA',
      operationKind: 'generation',
      statusUrl: 'https://app.narriflow.com/api/v1/operations/op_AAAAAAAAAAAAAAAAAAAAAAA',
      reviewUrl: 'https://app.narriflow.com/projects/00000000-0000-4000-8000-000000000004',
      replayed: false,
    },
    outputFields: ACCEPTED_FIELDS,
  },
});
