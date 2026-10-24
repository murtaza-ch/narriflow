import type { AutopilotEpisodeImportedSubject } from '../events';
import { hydrateProject } from '../hydrators';
import { eventTrigger } from './event-trigger';

export default eventTrigger<AutopilotEpisodeImportedSubject>({
  key: 'autopilot_episode_imported',
  noun: 'Autopilot Episode',
  label: 'Autopilot Episode Imported',
  description: 'Triggers when an Autopilot rule imports a new episode from its feed as a project.',
  types: ['autopilot.episode_imported'],
  accept: () => true,
  fields: (subject) => ({ ruleId: subject.ruleId, episodeId: subject.episodeId, projectId: subject.projectId }),
  details: { hydrator: hydrateProject, input: (subject) => ({ projectId: subject.projectId }) },
  sample: {
    id: '3a5b7c91-4d2e-4f6a-9b1c-8e0d2f4a6c68',
    eventType: 'autopilot.episode_imported',
    occurredAt: '2026-10-24T09:00:00.000Z',
    ruleId: '00000000-0000-4000-8000-000000000030',
    episodeId: 'https://feeds.example.com/podcast/episodes/42',
    projectId: '00000000-0000-4000-8000-000000000004',
    details: {
      available: true,
      projectTitle: 'Weekly strategy podcast, episode 42',
      sourceType: 'rss',
      durationSeconds: 3120,
      reviewUrl: 'https://app.narriflow.com/projects/00000000-0000-4000-8000-000000000004',
    },
  },
  outputFields: [
    { key: 'ruleId', label: 'Autopilot Rule ID' },
    { key: 'episodeId', label: 'Episode ID' },
    { key: 'projectId', label: 'Project ID' },
    { key: 'details__projectTitle', label: 'Project Title' },
    { key: 'details__sourceType', label: 'Source Type' },
    { key: 'details__durationSeconds', label: 'Duration (seconds)', type: 'number' },
    { key: 'details__reviewUrl', label: 'Review URL' },
  ],
});
