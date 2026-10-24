import { defineInputFields, defineSearch } from 'zapier-platform-core';
import { api, apiOrNull } from '../api';
import type { ProjectResult, ProjectsResult, ProjectView } from '../types';

interface Input {
  projectId?: string;
  title?: string;
}

const PAGE_SIZE = 100;
/** The 1,000 newest projects. */
const MAX_PAGES = 10;
const MAX_MATCHES = 10;

const inputFields = defineInputFields([
  { key: 'projectId', label: 'Project ID', helpText: 'An exact project ID. When set, the title is ignored.' },
  {
    key: 'title',
    label: 'Title Contains',
    helpText: 'Finds the newest projects whose title contains this text, ignoring case. Searches the newest 1,000 projects.',
  },
]);

function item(project: ProjectView, clipCount?: number) {
  return {
    id: project.projectId,
    projectId: project.projectId,
    title: project.title,
    sourceType: project.sourceType,
    ingestStatus: project.ingestStatus,
    durationSeconds: project.durationSeconds,
    languageCode: project.languageCode,
    createdAt: project.createdAt,
    reviewUrl: project.reviewUrl,
    ...(clipCount === undefined ? {} : { clipCount }),
  };
}

export default defineSearch({
  key: 'find_project',
  noun: 'Project',
  display: {
    label: 'Find Project',
    description: 'Finds a project by ID or by part of its title.',
  },
  operation: {
    inputFields,
    perform: async (z, bundle) => {
      const input = bundle.inputData as unknown as Input;
      const projectId = input.projectId?.trim();
      if (projectId) {
        const found = await apiOrNull<ProjectResult>(z, bundle, { path: `/projects/${encodeURIComponent(projectId)}` });
        return found ? [item(found.project)] : [];
      }
      const needle = input.title?.trim().toLowerCase();
      if (!needle) {
        throw new z.errors.Error('Enter a Project ID or part of a title.', 'invalid_input', 400);
      }
      const matches: ReturnType<typeof item>[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES && matches.length < MAX_MATCHES; page++) {
        const { data } = await api<ProjectsResult>(z, bundle, { path: '/projects', query: { limit: PAGE_SIZE, cursor } });
        for (const project of data.items) {
          if (project.title.toLowerCase().includes(needle)) matches.push(item(project, project.clipCount));
        }
        if (!data.nextCursor) break;
        cursor = data.nextCursor;
      }
      return matches.slice(0, MAX_MATCHES);
    },
    sample: {
      id: '00000000-0000-4000-8000-000000000004',
      projectId: '00000000-0000-4000-8000-000000000004',
      title: 'Weekly strategy podcast, episode 42',
      sourceType: 'rss',
      ingestStatus: 'ready',
      durationSeconds: 3120,
      languageCode: 'en',
      createdAt: '2026-10-24T09:00:00.000Z',
      reviewUrl: 'https://app.narriflow.com/projects/00000000-0000-4000-8000-000000000004',
      clipCount: 10,
    },
    outputFields: [
      { key: 'projectId', label: 'Project ID' },
      { key: 'title', label: 'Title' },
      { key: 'sourceType', label: 'Source Type' },
      { key: 'ingestStatus', label: 'Import Status' },
      { key: 'durationSeconds', label: 'Duration (seconds)', type: 'number' },
      { key: 'languageCode', label: 'Language' },
      { key: 'createdAt', label: 'Created At' },
      { key: 'reviewUrl', label: 'Review URL' },
      { key: 'clipCount', label: 'Clip Count (title search only)', type: 'integer' },
    ],
  },
});
