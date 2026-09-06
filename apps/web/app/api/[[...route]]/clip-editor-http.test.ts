import { describe, expect, test } from "bun:test";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
  type ClipSnapshot,
  type EditorDocument,
} from "@narriflow/validators";
import {
  createClipEditorHttpRoutes,
  type ClipEditorHttpDependencies,
} from "./clip-editor-http";

const ACTOR_USER_ID = "10000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "30000000-0000-4000-8000-000000000001";
const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const CLIP_ID = "50000000-0000-4000-8000-000000000001";

function document(): EditorDocument {
  return editorDocumentSchema.parse({
    version: 2,
    clipStartSec: 0,
    clipEndSec: 20,
    captionPreset: captionPresetSchema.parse({}),
    transcriptSlice: [],
    studioEdits: studioEditsSchema.parse({}),
    brollUrl: null,
    deletedRanges: [],
  });
}

const clip = { id: CLIP_ID, projectId: PROJECT_ID } as ClipSnapshot;

interface Calls {
  titles: unknown[][];
  mutations: unknown[];
  scenePolicy: unknown[][];
  changedVisualScenes: unknown[][];
  introducedVisualScenes: unknown[][];
  visualBroll: unknown[][];
  changedFontScenes: unknown[][];
  introducedFontScenes: unknown[][];
  generatedInsertions: unknown[][];
}

function dependencies(): {
  value: ClipEditorHttpDependencies;
  calls: Calls;
} {
  const current = document();
  const calls: Calls = {
    titles: [],
    mutations: [],
    scenePolicy: [],
    changedVisualScenes: [],
    introducedVisualScenes: [],
    visualBroll: [],
    changedFontScenes: [],
    introducedFontScenes: [],
    generatedInsertions: [],
  };
  return {
    calls,
    value: {
      getActor: () => ({
        actorUserId: ACTOR_USER_ID,
        workspaceId: WORKSPACE_ID,
        workspaceOwnerUserId: OWNER_USER_ID,
        role: "owner",
        status: "active",
        pricingTier: "creator",
        isPersonalWorkspace: true,
      }),
      clip: {
        updateClipTitle: async (...args) => {
          calls.titles.push(args);
          return clip;
        },
        getClipSnapshot: async () => clip,
        getClipEditorDocument: async () => ({
          revision: 7,
          document: current,
          original: current,
          layoutAnalysis: null,
          autoLayoutAnalysis: null,
          splitLayoutAnalysis: null,
          splitLayoutFailure: null,
          layoutAnalysisFailure: null,
        }),
      },
      persistence: {
        mutateDocument: async (input) => {
          calls.mutations.push(input);
          return { revision: 8, document: current, noop: false };
        },
      },
      analyzeSceneMutation: (...args) => {
        calls.scenePolicy.push(args);
        return {
          changedSceneBlocks: [],
          introducedSceneReferences: [],
          introducedVisualAssetIds: [],
        };
      },
      visualAssets: {
        assertSceneReferencesWithPolicy: async (...args) => {
          calls.changedVisualScenes.push(args);
        },
        assertSceneReferences: async (...args) => {
          calls.introducedVisualScenes.push(args);
        },
        assertVisualBrollReferences: async (...args) => {
          calls.visualBroll.push(args);
        },
        recordGeneratedInsertionsBestEffort: async (...args) => {
          calls.generatedInsertions.push(args);
        },
      },
      brandFonts: {
        assertSceneReferences: async (...args) => {
          const options = args[3];
          if (options.allowDeleted) calls.changedFontScenes.push(args);
          else calls.introducedFontScenes.push(args);
        },
      },
    },
  };
}

function app(deps: ClipEditorHttpDependencies) {
  return createClipEditorHttpRoutes(deps);
}

function request(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const clipPath = `/projects/${PROJECT_ID}/clips/${CLIP_ID}`;

describe("Clip Editor HTTP routes", () => {
  test("rejects invalid and unrecognized PATCH bodies", async () => {
    const { value } = dependencies();
    const routes = app(value);

    const invalid = await routes.request(new Request(`http://localhost${clipPath}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "null",
    }));
    const unrecognized = await routes.request(request("PATCH", clipPath, { unexpected: true }));

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_input" });
    expect(unrecognized.status).toBe(400);
    expect(await unrecognized.json()).toMatchObject({
      error: "unrecognized_clip_update",
    });
  });

  test("dispatches a title PATCH without mutating the editor document", async () => {
    const { value, calls } = dependencies();

    const response = await app(value).request(
      request("PATCH", clipPath, { title: "  New title  " }),
    );

    expect(response.status).toBe(200);
    expect(calls.titles).toEqual([
      [OWNER_USER_ID, PROJECT_ID, CLIP_ID, "New title"],
    ]);
    expect(calls.mutations).toEqual([]);
  });

  test.each([
    [{ startSec: 1, endSec: 12 }, { kind: "set_boundaries", startSec: 1, endSec: 12 }],
    [{ captionPreset: null }, { kind: "set_caption_preset", captionPreset: null }],
    [{ transcriptSlice: [] }, { kind: "set_transcript", transcriptSlice: [] }],
    [{ brollUrl: "https://media.test/broll.mp4" }, { kind: "set_broll_url", brollUrl: "https://media.test/broll.mp4" }],
    [{ studioEdits: studioEditsSchema.parse({}) }, { kind: "set_studio_edits", studioEdits: studioEditsSchema.parse({}) }],
  ])("dispatches a supported editor-document PATCH", async (payload, intent) => {
    const { value, calls } = dependencies();

    const response = await app(value).request(request("PATCH", clipPath, payload));

    expect(response.status).toBe(200);
    expect(calls.mutations).toHaveLength(1);
    expect(calls.mutations[0]).toMatchObject({
      actorUserId: ACTOR_USER_ID,
      workspaceId: WORKSPACE_ID,
      workspaceOwnerUserId: OWNER_USER_ID,
      projectId: PROJECT_ID,
      clipId: CLIP_ID,
      intent,
    });
  });

  test("does not treat an unrelated object as a studio-edits PATCH", async () => {
    const { value, calls } = dependencies();

    const response = await app(value).request(
      request("PATCH", clipPath, { captionPreset: "invalid" }),
    );

    expect(response.status).toBe(400);
    expect(calls.mutations).toEqual([]);
  });

  test("returns the current Clip Editor Document", async () => {
    const { value } = dependencies();

    const response = await app(value).request(
      request("GET", `${clipPath}/editor`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 7, document: { version: 2 } });
  });

  test("rejects an invalid Clip Editor Document replacement", async () => {
    const { value, calls } = dependencies();

    const response = await app(value).request(
      request("PUT", `${clipPath}/editor`, { baseRevision: 7, document: {} }),
    );

    expect(response.status).toBe(400);
    expect(calls.scenePolicy).toEqual([]);
    expect(calls.mutations).toEqual([]);
  });

  test("validates and persists a Clip Editor Document replacement", async () => {
    const { value, calls } = dependencies();
    const next = document();
    value.analyzeSceneMutation = (...args) => {
      calls.scenePolicy.push(args);
      return {
        changedSceneBlocks: [],
        introducedSceneReferences: [],
        introducedVisualAssetIds: ["60000000-0000-4000-8000-000000000001"],
      };
    };

    const response = await app(value).request(
      request("PUT", `${clipPath}/editor`, { baseRevision: 7, document: next }),
    );

    expect(response.status).toBe(200);
    expect(calls.scenePolicy).toHaveLength(1);
    expect(calls.changedVisualScenes).toHaveLength(1);
    expect(calls.introducedVisualScenes).toHaveLength(1);
    expect(calls.visualBroll).toHaveLength(1);
    expect(calls.changedFontScenes).toHaveLength(1);
    expect(calls.introducedFontScenes).toHaveLength(1);
    expect(calls.mutations[0]).toMatchObject({
      intent: { kind: "replace", baseRevision: 7, document: next },
    });
    expect(calls.generatedInsertions[0]?.[2]).toEqual([
      "60000000-0000-4000-8000-000000000001",
    ]);
    expect(await response.json()).toMatchObject({
      revision: 8,
      document: { version: 2 },
      clip: { id: CLIP_ID },
    });
  });

  test("resets through the existing Scene Block policy and reset intent", async () => {
    const { value, calls } = dependencies();

    const response = await app(value).request(
      request("POST", `${clipPath}/editor/reset`, { baseRevision: 7 }),
    );

    expect(response.status).toBe(200);
    expect(calls.scenePolicy).toHaveLength(1);
    expect(calls.mutations[0]).toMatchObject({
      intent: { kind: "reset", baseRevision: 7 },
    });
    expect(calls.changedVisualScenes).toEqual([]);
    expect(calls.introducedVisualScenes).toEqual([]);
  });
});
