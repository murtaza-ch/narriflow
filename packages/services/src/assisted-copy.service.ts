import { createHash, randomUUID } from "node:crypto";

export type AssistedCopyPlatform =
  | "tiktok"
  | "youtube_shorts"
  | "instagram_reels"
  | "facebook_reels"
  | "linkedin"
  | "x";

export type AssistedCopyStatus =
  | "generating"
  | "completed"
  | "rejected"
  | "failed"
  | "unknown";

export interface AssistedCopyContent {
  caption: string;
  hashtags: string[];
  title: string | null;
}

export interface AssistedCopyVoiceGuidance {
  tone: string;
  audience: string;
  preferredPhrases: string[];
  avoidedPhrases: string[];
  hashtagGuidance?: string;
}

export interface AssistedCopyContext {
  clipId: string;
  title: string | null;
  hook: string | null;
  payoff: string | null;
  brandProfileId: string | null;
  brandProfileRevision: number | null;
  voiceGuidance: AssistedCopyVoiceGuidance | null;
}

export interface AssistedCopyScope {
  actorUserId: string;
  workspaceId: string;
  projectId: string;
}

export interface GenerateAssistedCopyInput {
  idempotencyKey: string;
  clipId: string;
  platform: AssistedCopyPlatform;
  campaignNote: string;
  lockedTerms?: string[];
  sourceDraftId?: string;
}

export interface AssistedCopyProviderRequest {
  requestId: string;
  platform: AssistedCopyPlatform;
  context: AssistedCopyContext & { voiceGuidance: AssistedCopyVoiceGuidance };
  campaignNote: string;
  lockedTerms: string[];
  sourceDraftId: string | null;
  promptVersion: string;
  guidanceSkipped: boolean;
}

export type AssistedCopyProviderOutcome =
  | {
      kind: "completed";
      modelAlias: string;
      moderationOutcome: "accepted";
      usage: { inputTokens: number; outputTokens: number };
      content: AssistedCopyContent;
    }
  | {
      kind: "rejected" | "unknown" | "failed";
      modelAlias: string;
      moderationOutcome: "rejected" | "unknown";
      errorCode: string;
      usage?: { inputTokens: number; outputTokens: number };
    };

export interface AssistedCopyProvider {
  generate(request: AssistedCopyProviderRequest): Promise<AssistedCopyProviderOutcome>;
}

export interface AssistedCopyRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  clipId: string;
  platform: AssistedCopyPlatform;
  idempotencyKey: string;
  requestFingerprint: string;
  sourceDraftId: string | null;
  status: AssistedCopyStatus;
  revision: number;
  content: AssistedCopyContent | null;
  confirmed: boolean;
  confirmedAt: Date | null;
  modelAlias: string | null;
  promptVersion: string;
  moderationOutcome: "pending" | "accepted" | "rejected" | "unknown";
  errorCode: string | null;
  brandProfileId: string | null;
  brandProfileRevision: number | null;
  guidanceSkipped: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssistedCopyStore {
  readContext(input: AssistedCopyScope & { clipId: string }): Promise<AssistedCopyContext | null>;
  reserve(input: AssistedCopyRecord): Promise<{ record: AssistedCopyRecord; created: boolean }>;
  reconcileOverdue(input: AssistedCopyScope & {
    id?: string;
    platform?: AssistedCopyPlatform;
    now: Date;
  }): Promise<number>;
  settle(input: {
    id: string;
    workspaceId: string;
    projectId: string;
    status: Exclude<AssistedCopyStatus, "generating">;
    content: AssistedCopyContent | null;
    modelAlias: string;
    moderationOutcome: "accepted" | "rejected" | "unknown";
    errorCode: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    now: Date;
  }): Promise<AssistedCopyRecord>;
  read(input: AssistedCopyScope & { id: string }): Promise<AssistedCopyRecord | null>;
  listLatest(input: AssistedCopyScope & {
    platform: AssistedCopyPlatform;
    limit: number;
  }): Promise<AssistedCopyRecord[]>;
  confirm(input: AssistedCopyScope & {
    id: string;
    expectedRevision: number;
    content: AssistedCopyContent;
    now: Date;
  }): Promise<AssistedCopyRecord | null>;
}

export interface AssistedCopyView {
  id: string;
  clipId: string;
  platform: AssistedCopyPlatform;
  sourceDraftId: string | null;
  status: AssistedCopyStatus;
  revision: number;
  content: AssistedCopyContent | null;
  confirmed: boolean;
  moderationOutcome: "pending" | "accepted" | "rejected" | "unknown";
	modelAlias: string | null;
	promptVersion: string;
  guidanceSkipped: boolean;
  errorCode: string | null;
  replayed: boolean;
}

export class AssistedCopyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AssistedCopyError";
  }
}

const PROMPT_VERSION = "assisted-copy-v1";
export const ASSISTED_COPY_GENERATION_DEADLINE_MS = 30_000;
const NEUTRAL_GUIDANCE: AssistedCopyVoiceGuidance = {
  tone: "clear and direct",
  audience: "the intended social audience",
  preferredPhrases: [],
  avoidedPhrases: [],
  hashtagGuidance: "",
};

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedTerms(terms: string[] | undefined) {
  return [...new Set((terms ?? []).map((term) => term.trim()).filter(Boolean))].slice(0, 20);
}

function validateContent(content: AssistedCopyContent): AssistedCopyContent {
  const caption = content.caption.trim();
  const title = content.title?.trim() || null;
  const hashtags = [...new Set(content.hashtags.map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean))];
	if (
		!caption ||
		caption.length > 5_000 ||
		(title !== null && title.length > 300) ||
		hashtags.length > 30 ||
		hashtags.some((tag) => tag.length > 100)
	) {
    throw new AssistedCopyError(
      "assisted_copy_content_invalid",
      "Generated copy did not match the assisted-copy contract",
    );
  }
  return { caption, title, hashtags };
}

function view(record: AssistedCopyRecord, replayed: boolean): AssistedCopyView {
  return {
    id: record.id,
    clipId: record.clipId,
    platform: record.platform,
    sourceDraftId: record.sourceDraftId,
    status: record.status,
    revision: record.revision,
    content: record.content,
    confirmed: record.confirmed,
    moderationOutcome: record.moderationOutcome,
		modelAlias: record.modelAlias,
		promptVersion: record.promptVersion,
    guidanceSkipped: record.guidanceSkipped,
    errorCode: record.errorCode,
    replayed,
  };
}

export function createAssistedCopyService(dependencies: {
  store: AssistedCopyStore;
  provider: AssistedCopyProvider | (() => AssistedCopyProvider);
  authorize(scope: AssistedCopyScope): Promise<void>;
  authorizeRead?(scope: AssistedCopyScope): Promise<void>;
  diagnostics?: (event: Record<string, unknown>) => void;
  now?: () => Date;
  createId?: () => string;
}) {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const diagnostics = dependencies.diagnostics ?? (() => undefined);

  return {
    async generate(
      scope: AssistedCopyScope,
      rawInput: GenerateAssistedCopyInput,
    ): Promise<AssistedCopyView> {
      await dependencies.authorize(scope);
      const campaignNote = rawInput.campaignNote.trim();
      if (!campaignNote || campaignNote.length > 2_000) {
        throw new AssistedCopyError(
          "assisted_copy_campaign_note_invalid",
          "Campaign guidance must be between 1 and 2,000 characters",
        );
      }
      const lockedTerms = normalizedTerms(rawInput.lockedTerms);
      const context = await dependencies.store.readContext({ ...scope, clipId: rawInput.clipId });
      if (!context || context.clipId !== rawInput.clipId) {
        throw new AssistedCopyError("assisted_copy_clip_not_found", "The selected clip is unavailable");
      }
      if (rawInput.sourceDraftId) {
        const source = await dependencies.store.read({ ...scope, id: rawInput.sourceDraftId });
        if (!source || source.clipId !== rawInput.clipId || source.platform !== rawInput.platform) {
          throw new AssistedCopyError(
            "assisted_copy_source_invalid",
            "The source draft does not belong to this clip and platform",
          );
        }
      }

      const requestFingerprint = fingerprint({
        contract: PROMPT_VERSION,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        clipId: rawInput.clipId,
        platform: rawInput.platform,
        campaignNote,
        lockedTerms,
        sourceDraftId: rawInput.sourceDraftId ?? null,
        brandProfileId: context.brandProfileId,
        brandProfileRevision: context.brandProfileRevision,
      });
      const requestedAt = now();
      const reservation = await dependencies.store.reserve({
        id: createId(),
        ...scope,
        clipId: rawInput.clipId,
        platform: rawInput.platform,
        idempotencyKey: rawInput.idempotencyKey,
        requestFingerprint,
        sourceDraftId: rawInput.sourceDraftId ?? null,
        status: "generating",
        revision: 1,
        content: null,
        confirmed: false,
        confirmedAt: null,
        modelAlias: null,
        promptVersion: PROMPT_VERSION,
        moderationOutcome: "pending",
        errorCode: null,
        brandProfileId: context.brandProfileId,
        brandProfileRevision: context.brandProfileRevision,
        guidanceSkipped: context.voiceGuidance === null,
        inputTokens: null,
        outputTokens: null,
        createdAt: requestedAt,
        updatedAt: requestedAt,
      });
      if (!reservation.created) {
        if (reservation.record.requestFingerprint !== requestFingerprint) {
          throw new AssistedCopyError(
            "assisted_copy_idempotency_conflict",
            "The idempotency key was already used with different generation inputs",
          );
        }
        await dependencies.store.reconcileOverdue({
          ...scope,
          id: reservation.record.id,
          now: requestedAt,
        });
        const replay = await dependencies.store.read({
          ...scope,
          id: reservation.record.id,
        });
        return view(replay ?? reservation.record, true);
      }
      const guidanceSkipped = context.voiceGuidance === null;
      let outcome: AssistedCopyProviderOutcome;
      try {
				const provider =
					typeof dependencies.provider === "function"
						? dependencies.provider()
						: dependencies.provider;
        outcome = await provider.generate({
          requestId: reservation.record.id,
          platform: rawInput.platform,
          context: {
            ...context,
            voiceGuidance: context.voiceGuidance ?? NEUTRAL_GUIDANCE,
          },
          campaignNote,
          lockedTerms,
          sourceDraftId: rawInput.sourceDraftId ?? null,
          promptVersion: PROMPT_VERSION,
          guidanceSkipped,
        });
      } catch (error) {
        outcome = {
          kind: "failed",
          modelAlias: "unavailable",
          moderationOutcome: "unknown",
          errorCode:
            error instanceof AssistedCopyError
              ? error.code
              : "assisted_copy_provider_failed",
        };
      }

      let settledOutcome: AssistedCopyProviderOutcome = outcome;
      if (outcome.kind === "completed") {
        try {
          settledOutcome = { ...outcome, content: validateContent(outcome.content) };
        } catch {
          settledOutcome = {
            kind: "unknown",
            modelAlias: outcome.modelAlias,
            moderationOutcome: "unknown",
            errorCode: "assisted_copy_provider_outcome_unknown",
            usage: outcome.usage,
          };
        }
      }
      const settled = await dependencies.store.settle({
        id: reservation.record.id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        status: settledOutcome.kind,
        content: settledOutcome.kind === "completed" ? settledOutcome.content : null,
        modelAlias: settledOutcome.modelAlias,
        moderationOutcome: settledOutcome.moderationOutcome,
        errorCode: settledOutcome.kind === "completed" ? null : settledOutcome.errorCode,
        inputTokens: settledOutcome.usage?.inputTokens ?? null,
        outputTokens: settledOutcome.usage?.outputTokens ?? null,
        now: now(),
      });
      diagnostics({
        event: `assisted_copy_${settled.status}`,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        clipId: settled.clipId,
        draftId: settled.id,
        platform: settled.platform,
        modelAlias: settledOutcome.modelAlias,
        promptVersion: PROMPT_VERSION,
        moderationOutcome: settledOutcome.moderationOutcome,
        guidanceSkipped,
        inputTokens: settledOutcome.usage?.inputTokens ?? null,
        outputTokens: settledOutcome.usage?.outputTokens ?? null,
        errorCode: settled.errorCode,
      });
      return view(settled, false);
    },

    async confirm(
      scope: AssistedCopyScope,
      id: string,
      input: { expectedRevision: number; content: AssistedCopyContent },
    ): Promise<AssistedCopyView> {
      await dependencies.authorize(scope);
      const current = await dependencies.store.read({ ...scope, id });
      if (!current) {
        throw new AssistedCopyError("assisted_copy_not_found", "The assisted-copy draft is unavailable");
      }
      if (current.status !== "completed") {
        throw new AssistedCopyError(
          "assisted_copy_not_confirmable",
          "Only a completed assisted-copy draft can be confirmed",
        );
      }
      const confirmed = await dependencies.store.confirm({
        ...scope,
        id,
        expectedRevision: input.expectedRevision,
        content: validateContent(input.content),
        now: now(),
      });
      if (!confirmed) {
        throw new AssistedCopyError(
          "assisted_copy_revision_conflict",
          "The assisted-copy draft changed before it could be confirmed",
        );
      }
      diagnostics({
        event: "assisted_copy_confirmed",
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        clipId: confirmed.clipId,
        draftId: confirmed.id,
        platform: confirmed.platform,
        revision: confirmed.revision,
      });
      return view(confirmed, false);
    },

    async get(scope: AssistedCopyScope, id: string): Promise<AssistedCopyView> {
      await (dependencies.authorizeRead ?? dependencies.authorize)(scope);
      await dependencies.store.reconcileOverdue({ ...scope, id, now: now() });
      const current = await dependencies.store.read({ ...scope, id });
      if (!current) {
        throw new AssistedCopyError(
          "assisted_copy_not_found",
          "The assisted-copy draft is unavailable",
        );
      }
      return view(current, false);
    },

    async listLatest(
      scope: AssistedCopyScope,
      platform: AssistedCopyPlatform,
    ): Promise<AssistedCopyView[]> {
      await (dependencies.authorizeRead ?? dependencies.authorize)(scope);
      await dependencies.store.reconcileOverdue({ ...scope, platform, now: now() });
      const records = await dependencies.store.listLatest({
        ...scope,
        platform,
        limit: 100,
      });
      return records.map((record) => view(record, false));
    },
  };
}

export function createInMemoryAssistedCopyStore(input: {
  context: AssistedCopyContext;
}): AssistedCopyStore {
  const records = new Map<string, AssistedCopyRecord>();
  const unique = new Map<string, string>();
  const uniqueKey = (record: Pick<AssistedCopyRecord, "workspaceId" | "projectId" | "idempotencyKey">) =>
    `${record.workspaceId}:${record.projectId}:${record.idempotencyKey}`;

  return {
    async readContext(query) {
      return query.clipId === input.context.clipId ? structuredClone(input.context) : null;
    },
    async reserve(record) {
      const key = uniqueKey(record);
      const existingId = unique.get(key);
      if (existingId) {
        const existing = records.get(existingId);
        if (!existing) throw new Error("Assisted-copy in-memory store is inconsistent");
        return { record: structuredClone(existing), created: false };
      }
      records.set(record.id, structuredClone(record));
      unique.set(key, record.id);
      return { record: structuredClone(record), created: true };
    },
    async reconcileOverdue(query) {
      let reconciled = 0;
      for (const [id, current] of records) {
        if (
          current.workspaceId !== query.workspaceId ||
          current.projectId !== query.projectId ||
          current.status !== "generating" ||
          (query.id !== undefined && current.id !== query.id) ||
          (query.platform !== undefined && current.platform !== query.platform) ||
          current.createdAt.getTime() + ASSISTED_COPY_GENERATION_DEADLINE_MS >
            query.now.getTime()
        ) {
          continue;
        }
        records.set(id, {
          ...current,
          status: "unknown",
          moderationOutcome: "unknown",
          errorCode: "assisted_copy_provider_outcome_unknown",
          updatedAt: query.now,
        });
        reconciled += 1;
      }
      return reconciled;
    },
    async settle(update) {
      const current = records.get(update.id);
      if (
        !current ||
        current.workspaceId !== update.workspaceId ||
        current.projectId !== update.projectId
      ) {
        throw new AssistedCopyError("assisted_copy_not_found", "The assisted-copy draft is unavailable");
      }
      if (current.status !== "generating") return structuredClone(current);
      const next: AssistedCopyRecord = {
        ...current,
        status: update.status,
        content: update.content ? structuredClone(update.content) : null,
        modelAlias: update.modelAlias,
        moderationOutcome: update.moderationOutcome,
        errorCode: update.errorCode,
        inputTokens: update.inputTokens,
        outputTokens: update.outputTokens,
        updatedAt: update.now,
      };
      records.set(next.id, next);
      return structuredClone(next);
    },
    async read(query) {
      const record = records.get(query.id);
      return record &&
        record.workspaceId === query.workspaceId &&
        record.projectId === query.projectId
        ? structuredClone(record)
        : null;
    },
    async listLatest(query) {
      const latest = new Map<string, AssistedCopyRecord>();
      for (const record of [...records.values()].reverse()) {
        if (
          record.workspaceId !== query.workspaceId ||
          record.projectId !== query.projectId ||
          record.platform !== query.platform ||
          latest.has(record.clipId)
        ) {
          continue;
        }
        latest.set(record.clipId, record);
        if (latest.size === query.limit) break;
      }
      return [...latest.values()].map((record) => structuredClone(record));
    },
    async confirm(update) {
      const current = records.get(update.id);
      if (
        !current ||
        current.workspaceId !== update.workspaceId ||
        current.projectId !== update.projectId ||
        current.revision !== update.expectedRevision ||
        current.status !== "completed"
      ) {
        return null;
      }
      const next: AssistedCopyRecord = {
        ...current,
        content: structuredClone(update.content),
        confirmed: true,
        confirmedAt: update.now,
        revision: current.revision + 1,
        updatedAt: update.now,
      };
      records.set(next.id, next);
      return structuredClone(next);
    },
  };
}
