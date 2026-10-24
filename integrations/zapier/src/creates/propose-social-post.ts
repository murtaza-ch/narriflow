import { defineCreate, defineInputFields } from 'zapier-platform-core';
import { api } from '../api';
import { idempotencyKey, RUN_KEY_FIELD } from '../idempotency';
import type { ProposedSocialPost } from '../types';

interface Input {
  clipId: string;
  exportId: string;
  socialAccountId: string;
  caption?: string;
  runKey?: string;
}

const inputFields = defineInputFields([
  {
    key: 'clipId',
    label: 'Clip ID',
    required: true,
    helpText: 'From the Export Finished trigger.',
  },
  {
    key: 'exportId',
    label: 'Export ID',
    required: true,
    helpText: 'A finished export of that clip, from the Export Finished or Finishing Ready trigger.',
  },
  {
    key: 'socialAccountId',
    label: 'Social Account',
    required: true,
    dynamic: 'social_account_list.id.name',
  },
  {
    key: 'caption',
    label: 'Caption',
    type: 'text',
    helpText: 'Up to 5,000 characters. Leave empty to use the latest copy Narriflow wrote for that platform, if any.',
  },
  RUN_KEY_FIELD,
]);

export default defineCreate({
  key: 'propose_social_post',
  noun: 'Post Proposal',
  display: {
    label: 'Propose Social Post',
    description:
      'Adds a clip to a social account\'s Publishing Queue as a draft. Nothing is published until a person accepts it in Narriflow.',
  },
  operation: {
    inputFields,
    perform: async (z, bundle) => {
      const input = bundle.inputData as unknown as Input;
      const body = {
        clipId: input.clipId.trim(),
        exportId: input.exportId.trim(),
        socialAccountId: input.socialAccountId,
        caption: input.caption?.trim() || undefined,
      };
      const { data } = await api<ProposedSocialPost>(z, bundle, {
        method: 'POST',
        path: '/social-posts/proposals',
        body,
        idempotencyKey: idempotencyKey('propose-social-post', body, input.runKey),
      });
      const { proposal } = data;
      return {
        id: proposal.proposalId,
        proposalId: proposal.proposalId,
        projectId: proposal.projectId,
        clipId: proposal.clipId,
        socialAccountId: proposal.socialAccountId,
        platform: proposal.platform,
        caption: proposal.caption,
        source: proposal.source,
        exportId: proposal.exportId,
        aspectRatio: proposal.aspectRatio,
        queueUrl: data.queueUrl,
        replayed: data.replayed,
      };
    },
    sample: {
      id: '00000000-0000-4000-8000-000000000070',
      proposalId: '00000000-0000-4000-8000-000000000070',
      projectId: '00000000-0000-4000-8000-000000000004',
      clipId: '00000000-0000-4000-8000-000000000010',
      socialAccountId: '00000000-0000-4000-8000-000000000060',
      platform: 'tiktok',
      caption: 'Nobody tells you what happens after launch day.',
      source: 'integration',
      exportId: '00000000-0000-4000-8000-000000000020',
      aspectRatio: '9:16',
      queueUrl: 'https://app.narriflow.com/calendar/queue',
      replayed: false,
    },
    outputFields: [
      { key: 'proposalId', label: 'Proposal ID' },
      { key: 'projectId', label: 'Project ID' },
      { key: 'clipId', label: 'Clip ID' },
      { key: 'socialAccountId', label: 'Social Account ID' },
      { key: 'platform', label: 'Platform' },
      { key: 'caption', label: 'Caption' },
      { key: 'source', label: 'Source' },
      { key: 'exportId', label: 'Export ID' },
      { key: 'aspectRatio', label: 'Format' },
      { key: 'queueUrl', label: 'Publishing Queue URL' },
      { key: 'replayed', label: 'Replay of an Earlier Identical Request', type: 'boolean' },
    ],
  },
});
