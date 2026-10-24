import type { PlainOutputField } from 'zapier-platform-core';
import type { SocialPostFinishedSubject } from '../events';
import { hydratePostClip } from '../hydrators';
import { PLATFORM_LABELS } from '../types';
import { eventTrigger } from './event-trigger';

/** Both post triggers read `social_post.finished`, which needs the `publishing:read` scope. */
const TYPES = ['social_post.finished'] as const;

const POST_FIELDS: PlainOutputField[] = [
  { key: 'socialPostId', label: 'Social Post ID' },
  { key: 'projectId', label: 'Project ID' },
  { key: 'clipId', label: 'Clip ID' },
  { key: 'platform', label: 'Platform' },
  { key: 'platformName', label: 'Platform Name' },
  { key: 'state', label: 'State' },
  { key: 'details__clipTitle', label: 'Clip Title' },
  { key: 'details__clipReviewUrl', label: 'Clip Review URL' },
];

const postFields = (subject: SocialPostFinishedSubject) => ({
  socialPostId: subject.socialPostId,
  projectId: subject.projectId,
  clipId: subject.clipId,
  platform: subject.platform,
  platformName: PLATFORM_LABELS[subject.platform] ?? subject.platform,
  state: subject.state,
});

const postDetails = { hydrator: hydratePostClip, input: (subject: SocialPostFinishedSubject) => ({ clipId: subject.clipId }) };

const sample = {
  eventType: 'social_post.finished',
  occurredAt: '2026-10-24T15:00:00.000Z',
  socialPostId: '00000000-0000-4000-8000-000000000040',
  projectId: '00000000-0000-4000-8000-000000000004',
  clipId: '00000000-0000-4000-8000-000000000010',
  platform: 'tiktok',
  platformName: 'TikTok',
  details: {
    available: true,
    clipTitle: 'Why most launches fail in week two',
    clipReviewUrl: 'https://app.narriflow.com/projects/00000000-0000-4000-8000-000000000004/clips/00000000-0000-4000-8000-000000000010',
  },
};

export const postPublished = eventTrigger<SocialPostFinishedSubject>({
  key: 'post_published',
  noun: 'Published Post',
  label: 'Post Published',
  description: 'Triggers when a scheduled social post is published. Needs an API key with the publishing:read permission.',
  types: TYPES,
  accept: ({ subject }) => subject.state === 'posted',
  fields: postFields,
  details: postDetails,
  sample: { id: 'b1c3d5e7-6f8a-4b0c-8d2e-4a6c8e0f2a84', ...sample, state: 'posted' },
  outputFields: POST_FIELDS,
});

export const postNeedsAttention = eventTrigger<SocialPostFinishedSubject>({
  key: 'post_needs_attention',
  noun: 'Post Needing Attention',
  label: 'Post Needs Attention',
  description:
    'Triggers when a scheduled social post failed or needs a person to check it in Narriflow. Needs an API key with the publishing:read permission.',
  types: TYPES,
  accept: ({ subject }) => subject.state === 'needs_attention' || subject.state === 'failed',
  fields: postFields,
  details: postDetails,
  sample: { id: 'c2d4e6f8-7a9b-4c1d-9e3f-5b7d9f1a3b95', ...sample, state: 'needs_attention' },
  outputFields: POST_FIELDS,
});
