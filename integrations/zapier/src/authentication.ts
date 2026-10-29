import type { Authentication, Bundle, ZObject } from 'zapier-platform-core';
import { api } from './api';

interface WorkspaceResult {
  workspace: { workspaceId: string; name: string };
}

const authentication: Authentication = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      helpText:
        'Create a Workspace API key in Narriflow under Settings, then Developer access. The Workspace needs the Pro or Business plan. See https://app.narriflow.com/docs/api/zapier for the permissions to turn on.',
    },
    {
      key: 'baseUrl',
      label: 'Narriflow URL',
      type: 'string',
      required: true,
      helpText: 'Enter the public HTTPS API origin supplied by your deployment. Use the API host, with no /api/v1 path. For local testing, explicitly enter http://localhost:4000.',
    },
  ],
  // The connection test reads the Workspace, which also proves the key's Workspace has API access.
  test: async (z: ZObject, bundle: Bundle) => {
    const { data } = await api<WorkspaceResult>(z, bundle, { path: '/workspace' });
    return data;
  },
  // The test response arrives as inputData, so each connection is labelled with its Workspace.
  connectionLabel: async (_z: ZObject, bundle: Bundle) => {
    const result = bundle.inputData as unknown as Partial<WorkspaceResult>;
    return result.workspace?.name ?? 'Narriflow';
  },
};

export default authentication;
