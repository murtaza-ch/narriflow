import { defineInputFields, defineSearch } from 'zapier-platform-core';
import { apiOrNull } from '../api';
import type { ExportDownload } from '../types';

interface Input {
  exportId: string;
  variantId?: string;
}

/** Download Grants are private URLs that stop working 15 minutes after they are issued. */
const EXPIRY_NOTE = 'These download links expire 15 minutes after this step runs. Use or save the files in the next steps.';

const inputFields = defineInputFields([
  {
    key: 'exportId',
    label: 'Export ID',
    required: true,
    helpText: `From the Export Finished or Finishing Ready trigger. ${EXPIRY_NOTE}`,
  },
  {
    key: 'variantId',
    label: 'Format ID',
    helpText: 'Only the file for this format. Leave empty for the first format, with all formats listed under Files.',
  },
]);

export default defineSearch({
  key: 'get_export_download',
  noun: 'Export Download',
  display: {
    label: 'Get Export Download',
    description: `Issues fresh download links and subtitles for a finished export. ${EXPIRY_NOTE}`,
  },
  operation: {
    inputFields,
    perform: async (z, bundle) => {
      const input = bundle.inputData as unknown as Input;
      const exportId = input.exportId.trim();
      const grants = await apiOrNull<ExportDownload>(z, bundle, {
        path: `/exports/${encodeURIComponent(exportId)}/download`,
        query: { variantId: input.variantId?.trim() || undefined },
      });
      if (!grants) return [];
      const first = grants.variants[0];
      const subtitle = (format: 'srt' | 'vtt') => grants.subtitles.find((entry) => entry.format === format)?.content ?? null;
      return [
        {
          id: grants.exportId,
          exportId: grants.exportId,
          projectId: grants.projectId,
          clipId: grants.clipId,
          editorRevision: grants.editorRevision,
          downloadUrl: first?.downloadUrl ?? null,
          fileName: first?.fileName ?? null,
          aspectRatio: first?.aspectRatio ?? null,
          resolution: first?.resolution ?? null,
          watermark: first?.watermark ?? null,
          expiresAt: grants.variants.map((variant) => variant.expiresAt).sort()[0] ?? null,
          expiryNote: EXPIRY_NOTE,
          files: grants.variants.map((variant) => ({
            variantId: variant.variantId,
            aspectRatio: variant.aspectRatio,
            resolution: variant.resolution,
            watermark: variant.watermark,
            fileName: variant.fileName,
            sizeBytes: variant.sizeBytes,
            downloadUrl: variant.downloadUrl,
            expiresAt: variant.expiresAt,
          })),
          srt: subtitle('srt'),
          vtt: subtitle('vtt'),
        },
      ];
    },
    sample: {
      id: '00000000-0000-4000-8000-000000000020',
      exportId: '00000000-0000-4000-8000-000000000020',
      projectId: '00000000-0000-4000-8000-000000000004',
      clipId: '00000000-0000-4000-8000-000000000010',
      editorRevision: 3,
      downloadUrl: 'https://files.example.com/signed/clip-9x16.mp4?signature=redacted',
      fileName: 'why-most-launches-fail-9x16.mp4',
      aspectRatio: '9:16',
      resolution: '1080p',
      watermark: false,
      expiresAt: '2026-10-24T12:20:00.000Z',
      expiryNote: EXPIRY_NOTE,
      files: [
        {
          variantId: '00000000-0000-4000-8000-000000000080',
          aspectRatio: '9:16',
          resolution: '1080p',
          watermark: false,
          fileName: 'why-most-launches-fail-9x16.mp4',
          sizeBytes: 12582912,
          downloadUrl: 'https://files.example.com/signed/clip-9x16.mp4?signature=redacted',
          expiresAt: '2026-10-24T12:20:00.000Z',
        },
      ],
      srt: '1\n00:00:00,000 --> 00:00:02,000\nNobody tells you what happens after launch day.\n',
      vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nNobody tells you what happens after launch day.\n',
    },
    outputFields: [
      { key: 'exportId', label: 'Export ID' },
      { key: 'projectId', label: 'Project ID' },
      { key: 'clipId', label: 'Clip ID' },
      { key: 'editorRevision', label: 'Editor Revision', type: 'integer' },
      { key: 'downloadUrl', label: 'Download URL (first format, expires in 15 minutes)' },
      { key: 'fileName', label: 'File Name (first format)' },
      { key: 'aspectRatio', label: 'Format (first format)' },
      { key: 'resolution', label: 'Resolution (first format)' },
      { key: 'watermark', label: 'Watermarked (first format)', type: 'boolean' },
      { key: 'expiresAt', label: 'Links Expire At' },
      { key: 'expiryNote', label: 'Expiry Note' },
      {
        key: 'files',
        label: 'Files',
        children: [
          { key: 'files__variantId', label: 'Format ID' },
          { key: 'files__aspectRatio', label: 'Format' },
          { key: 'files__resolution', label: 'Resolution' },
          { key: 'files__watermark', label: 'Watermarked', type: 'boolean' },
          { key: 'files__fileName', label: 'File Name' },
          { key: 'files__sizeBytes', label: 'Size (bytes)', type: 'integer' },
          { key: 'files__downloadUrl', label: 'Download URL (expires in 15 minutes)' },
          { key: 'files__expiresAt', label: 'Link Expires At' },
        ],
      },
      { key: 'srt', label: 'Subtitles (SRT text)' },
      { key: 'vtt', label: 'Subtitles (WebVTT text)' },
    ],
  },
});
