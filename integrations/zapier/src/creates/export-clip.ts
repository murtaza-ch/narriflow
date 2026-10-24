import { defineCreate, defineInputFields } from 'zapier-platform-core';
import { api } from '../api';
import { idempotencyKey, RUN_KEY_FIELD } from '../idempotency';
import type { ClipResult, CreatedExport } from '../types';

interface Input {
  clipId: string;
  aspectRatios?: string[] | string;
  resolution?: string;
  runKey?: string;
}

const ASPECT_RATIOS = ['9:16', '1:1', '16:9', '4:5'];

const inputFields = defineInputFields([
  {
    key: 'clipId',
    label: 'Clip ID',
    required: true,
    helpText: 'From the Clips Ready trigger (Top Clip ID, or a clip in the Clips list).',
  },
  {
    key: 'aspectRatios',
    label: 'Formats',
    list: true,
    choices: { '9:16': '9:16 vertical', '1:1': '1:1 square', '16:9': '16:9 landscape', '4:5': '4:5 portrait' },
    helpText: 'Leave empty for 9:16.',
  },
  {
    key: 'resolution',
    label: 'Resolution',
    choices: { '1080p': '1080p', '720p': '720p' },
    helpText: 'Leave empty for 1080p. A plan that does not include 1080p exports at 720p, and says so in Granted Resolution.',
  },
  RUN_KEY_FIELD,
]);

function formats(value: Input['aspectRatios']): string[] {
  const chosen = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unique = [...new Set(chosen.length > 0 ? chosen : ['9:16'])];
  // Sorted in the order the API lists them, so the same set of formats is always the same request.
  return unique.sort((a, b) => ASPECT_RATIOS.indexOf(a) - ASPECT_RATIOS.indexOf(b));
}

export default defineCreate({
  key: 'export_clip',
  noun: 'Export',
  display: {
    label: 'Export Clip',
    description:
      'Exports the clip as it is now, in the formats you choose. Use the Export Finished trigger to know when the files are ready.',
  },
  operation: {
    inputFields,
    perform: async (z, bundle) => {
      const input = bundle.inputData as unknown as Input;
      const clipId = input.clipId.trim();
      // An export is bound to one editor revision. Reading it here means a Zap
      // exports what the clip looks like now, and an edit later is a new request.
      const { data: current } = await api<ClipResult>(z, bundle, { path: `/clips/${encodeURIComponent(clipId)}` });
      const body = {
        expectedRevision: current.clip.editorRevision,
        aspectRatios: formats(input.aspectRatios),
        resolution: input.resolution || '1080p',
      };
      const { data, replayed } = await api<CreatedExport>(z, bundle, {
        method: 'POST',
        path: `/clips/${encodeURIComponent(clipId)}/exports`,
        body,
        idempotencyKey: idempotencyKey('export-clip', { clipId, ...body }, input.runKey),
      });
      return {
        id: data.export.exportId,
        exportId: data.export.exportId,
        projectId: data.export.projectId,
        clipId: data.export.clipId,
        editorRevision: data.export.editorRevision,
        status: data.export.status,
        reused: data.reused,
        grantedResolution: data.output.granted.resolution,
        watermark: data.output.granted.watermark,
        operationId: data.operation.operationId,
        reviewUrl: data.export.reviewUrl,
        replayed,
      };
    },
    sample: {
      id: '00000000-0000-4000-8000-000000000020',
      exportId: '00000000-0000-4000-8000-000000000020',
      projectId: '00000000-0000-4000-8000-000000000004',
      clipId: '00000000-0000-4000-8000-000000000010',
      editorRevision: 3,
      status: 'queued',
      reused: false,
      grantedResolution: '1080p',
      watermark: false,
      operationId: 'op_BBBBBBBBBBBBBBBBBBBBBBB',
      reviewUrl:
        'https://app.narriflow.com/projects/00000000-0000-4000-8000-000000000004/clips/00000000-0000-4000-8000-000000000010/exports/00000000-0000-4000-8000-000000000020',
      replayed: false,
    },
    outputFields: [
      { key: 'exportId', label: 'Export ID' },
      { key: 'projectId', label: 'Project ID' },
      { key: 'clipId', label: 'Clip ID' },
      { key: 'editorRevision', label: 'Editor Revision', type: 'integer' },
      { key: 'status', label: 'Status' },
      { key: 'reused', label: 'Reused an Identical Export', type: 'boolean' },
      { key: 'grantedResolution', label: 'Granted Resolution' },
      { key: 'watermark', label: 'Watermarked', type: 'boolean' },
      { key: 'operationId', label: 'Operation ID' },
      { key: 'reviewUrl', label: 'Review URL' },
      { key: 'replayed', label: 'Replay of an Earlier Identical Request', type: 'boolean' },
    ],
  },
});
