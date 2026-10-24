import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  LIBRARY_SEARCH_DEFAULT_LIMIT,
  LIBRARY_SEARCH_MAX_LIMIT,
  librarySearchQuerySchema,
  type LibraryPassage,
} from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import { ExpectedDomainFailureError, type ExpectedDomainFailureCatalog } from "./expected-domain-failure";
import { chunkUtterances, type TranscriptPassageDraft } from "./library-passages";
import { EMBEDDING_INPUT_MAX_CHARS, EmbeddingProviderError, type EmbeddingProvider } from "./openai-embedding-provider";
import { accessibleProjectSql } from "./project-access";

const failureKinds = {
  library_search_query_invalid: "invalid",
  library_search_unavailable: "unavailable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

const failureMessages: Record<keyof typeof failureKinds, string> = {
  library_search_query_invalid: "Search for 2 to 300 characters",
  library_search_unavailable: "Library search is temporarily unavailable",
};

export class LibrarySearchError extends ExpectedDomainFailureError<keyof typeof failureKinds> {
  constructor(code: keyof typeof failureKinds) {
    super({ code, kind: failureKinds[code], message: failureMessages[code] });
    this.name = "LibrarySearchError";
  }
}

export interface LibrarySearchInput {
  query: string;
  limit?: number;
  /** Search only these Projects. Projects the actor cannot see never match. */
  projectIds?: readonly string[];
}

/** Reciprocal rank fusion: a passage scores 1 / (RRF_K + rank) in each list it
 * appears in, so agreement between meaning and words wins without tuning
 * weights between cosine distance and text rank. */
const RRF_K = 60;
/** Each list contributes at most this many candidates per requested result. */
const CANDIDATES_PER_RESULT = 4;
const MIN_CANDIDATES = 40;
const MAX_PROJECT_FILTER = 50;
const CLAIM_LEASE_SECONDS = 10 * 60;
/** A transcript that keeps failing is left alone after this many attempts;
 * `passagesIndexError` says why. Reset `passagesAttempts` to try it again. */
export const MAX_INDEX_ATTEMPTS = 8;
const RETRY_BASE_SECONDS = 30;
const RETRY_MAX_SECONDS = 60 * 60;
const MAX_QUERY_TERMS = 12;

/** One embeddings request carries at most this many inputs and an estimated
 * token total under the provider's 300,000-token request limit. */
export interface EmbeddingBatchLimits {
  maxInputs: number;
  maxEstimatedTokens: number;
}

const DEFAULT_BATCH_LIMITS: EmbeddingBatchLimits = { maxInputs: 128, maxEstimatedTokens: 200_000 };
/** A conservative three characters per token, over text the provider has
 * already cut to its per-input maximum. */
const estimatedTokens = (text: string) => Math.ceil(Math.min(text.length, EMBEDDING_INPUT_MAX_CHARS) / 3);

/** Splits passages, in order, into requests within `limits`. */
export function planEmbeddingBatches<T extends { text: string }>(items: readonly T[], limits: EmbeddingBatchLimits = DEFAULT_BATCH_LIMITS): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const cost = estimatedTokens(item.text);
    if (current.length > 0 && (current.length >= limits.maxInputs || tokens + cost > limits.maxEstimatedTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(item);
    tokens += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface LibrarySearchDependencies {
  prisma: PrismaClient;
  embeddings: EmbeddingProvider;
  batch?: EmbeddingBatchLimits;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

interface ClaimedTranscript {
  id: string;
  projectId: string;
  workspaceId: string;
  completedAt: Date;
  attempts: number;
  utterancesJson: unknown;
}

interface IndexProgress {
  embedded: number;
  tokens: number;
}

type PassageRow = {
  projectId: string;
  projectTitle: string;
  startMs: number;
  endMs: number;
  text: string;
  score: number;
};

function vectorLiteral(vector: readonly number[]) {
  return `[${vector.join(",")}]`;
}

/** Words only, so no query syntax from the user reaches Postgres. Joined with
 * `or` so a question still finds passages that share only some of its words;
 * rank still favors the passages that share the most. */
export function lexicalQueryText(query: string) {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, MAX_QUERY_TERMS);
  return terms.length > 0 ? terms.join(" or ") : null;
}

function timedUtterances(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const utterance = item as { startSec?: unknown; endSec?: unknown; text?: unknown } | null;
    return utterance &&
      typeof utterance.startSec === "number" &&
      typeof utterance.endSec === "number" &&
      typeof utterance.text === "string"
      ? [{ startSec: utterance.startSec, endSec: utterance.endSec, text: utterance.text }]
      : [];
  });
}

/** Search over embedded transcript passages, and the indexing that feeds it.
 * Callers authorize the actor first; every query is still scoped to the
 * actor's Workspace and its accessible Projects. */
export class LibrarySearch {
  constructor(private readonly deps: LibrarySearchDependencies) {}

  private log(entry: Record<string, unknown>) {
    (this.deps.log ?? ((value) => console.warn(JSON.stringify(value))))(entry);
  }

  async search(scope: ActorScope, input: LibrarySearchInput): Promise<LibraryPassage[]> {
    const parsed = librarySearchQuerySchema.safeParse(input.query);
    if (!parsed.success) throw new LibrarySearchError("library_search_query_invalid");
    const query = parsed.data;
    const limit = Math.min(Math.max(Math.floor(input.limit ?? LIBRARY_SEARCH_DEFAULT_LIMIT), 1), LIBRARY_SEARCH_MAX_LIMIT);
    const projectIds = input.projectIds?.slice(0, MAX_PROJECT_FILTER);
    if (projectIds && projectIds.length === 0) return [];

    let embedded: Awaited<ReturnType<EmbeddingProvider["embed"]>>;
    try {
      embedded = await this.deps.embeddings.embed([query]);
    } catch (error) {
      this.log({ level: "warn", message: "library_query_embedding_failed", workspaceId: scope.workspaceId, code: error instanceof Error ? error.message : "unknown" });
      throw new LibrarySearchError("library_search_unavailable");
    }
    this.log({ level: "info", message: "library_query_embedded", workspaceId: scope.workspaceId, model: this.deps.embeddings.model, tokens: embedded.tokens });

    // Both lists filter by Workspace and accessible Projects before ranking.
    const candidates = Math.max(limit * CANDIDATES_PER_RESULT, MIN_CANDIDATES);
    const workspaceId = scope.workspaceId;
    const visible = Prisma.sql`tp."workspaceId" = ${workspaceId}::uuid AND p."workspaceId" = ${workspaceId}::uuid
      AND ${accessibleProjectSql("p", this.deps.now?.())} AND tp."embeddingModel" = ${this.deps.embeddings.model}
      ${projectIds ? Prisma.sql`AND tp."projectId" = ANY(${[...projectIds]}::uuid[])` : Prisma.empty}`;
    const words = lexicalQueryText(query);
    const lexical = words
      ? Prisma.sql`SELECT id, row_number() OVER (ORDER BY text_rank DESC, id) AS position FROM (
          SELECT tp.id, ts_rank_cd(tp."searchText", terms.query) AS text_rank
          FROM "TranscriptPassage" tp
          JOIN "Project" p ON p.id = tp."projectId",
          websearch_to_tsquery('english', ${words}) AS terms(query)
          WHERE tp."searchText" @@ terms.query AND ${visible}
          ORDER BY text_rank DESC LIMIT ${candidates}::int
        ) ranked`
      : Prisma.sql`SELECT NULL::uuid AS id, NULL::bigint AS position WHERE false`;

    // Exact ordering with filters: pgvector's iterative scan keeps reading the
    // HNSW index until the filtered LIMIT is met.
    const [, rows] = await this.deps.prisma.$transaction([
      this.deps.prisma.$queryRaw`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`,
      this.deps.prisma.$queryRaw<PassageRow[]>`
        WITH semantic AS (
          SELECT id, row_number() OVER (ORDER BY distance, id) AS position FROM (
            SELECT tp.id, tp."embedding" <=> ${vectorLiteral(embedded.vectors[0] ?? [])}::vector AS distance
            FROM "TranscriptPassage" tp
            JOIN "Project" p ON p.id = tp."projectId"
            WHERE ${visible}
            ORDER BY distance LIMIT ${candidates}::int
          ) ranked
        ), lexical AS (${lexical})
        SELECT tp."projectId", p."title" AS "projectTitle", tp."startMs", tp."endMs", tp."text",
          (COALESCE(1.0 / (${RRF_K}::int + semantic.position), 0) + COALESCE(1.0 / (${RRF_K}::int + lexical.position), 0))::double precision AS score
        FROM semantic
        FULL OUTER JOIN lexical ON lexical.id = semantic.id
        JOIN "TranscriptPassage" tp ON tp.id = COALESCE(semantic.id, lexical.id)
        JOIN "Project" p ON p.id = tp."projectId"
        ORDER BY score DESC, tp."projectId", tp."startMs"
        LIMIT ${limit}::int`,
    ]);
    return rows.map((row) => ({
      projectId: row.projectId,
      projectTitle: row.projectTitle,
      startMs: Number(row.startMs),
      endMs: Number(row.endMs),
      text: row.text,
      score: Number(row.score),
    }));
  }

  /** Indexes the next completed transcript that is new, changed, or due for a
   * retry. Returns how many it indexed. Failures back off and are logged; they
   * never throw, so indexing cannot disturb generation. */
  async indexNext(): Promise<number> {
    if (!this.deps.embeddings.configured) return 0;
    const claimed = await this.claim();
    if (!claimed) return 0;
    const progress = { embedded: 0, tokens: 0 };
    try {
      await this.index(claimed, progress);
      return 1;
    } catch (error) {
      await this.retryLater(claimed, error, progress);
      return 0;
    }
  }

  private async claim(): Promise<ClaimedTranscript | null> {
    const rows = await this.deps.prisma.$queryRaw<ClaimedTranscript[]>`
      UPDATE "Transcript" AS t
      SET "passagesAttempts" = t."passagesAttempts" + 1,
          "passagesRetryAt" = (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${CLAIM_LEASE_SECONDS}::double precision)
      FROM "Project" AS p
      WHERE p.id = t."projectId"
        AND t.id = (
          SELECT c.id FROM "Transcript" c JOIN "Project" cp ON cp.id = c."projectId"
          WHERE c.status = 'completed' AND c."completedAt" IS NOT NULL AND c."utterancesJson" IS NOT NULL
            AND (c."passagesIndexedFor" IS NULL OR c."passagesIndexedFor" < c."completedAt")
            AND (c."passagesRetryAt" IS NULL OR c."passagesRetryAt" <= (clock_timestamp() AT TIME ZONE 'UTC'))
            AND c."passagesAttempts" < ${MAX_INDEX_ATTEMPTS}::int
            AND cp."purgeStartedAt" IS NULL
          ORDER BY c."completedAt"
          LIMIT 1
          FOR UPDATE OF c SKIP LOCKED
        )
      RETURNING t.id, t."projectId", p."workspaceId", t."completedAt", t."passagesAttempts" AS attempts, t."utterancesJson"`;
    return rows[0] ?? null;
  }

  private async index(transcript: ClaimedTranscript, progress: IndexProgress) {
    const { prisma, embeddings } = this.deps;
    const started = Date.now();
    const drafts = [...new Map(chunkUtterances(timedUtterances(transcript.utterancesJson)).map((draft) => [draft.contentHash, draft])).values()];
    const existing = await prisma.$queryRaw<Array<{ contentHash: string }>>`
      SELECT "contentHash" FROM "TranscriptPassage"
      WHERE "transcriptId" = ${transcript.id}::uuid AND "embeddingModel" = ${embeddings.model}`;
    const known = new Set(existing.map((row) => row.contentHash));
    const fresh = drafts.filter((draft) => !known.has(draft.contentHash));

    // Each batch is stored as soon as it is embedded, so a failure later in the
    // transcript keeps what was already paid for and a retry skips it.
    for (const batch of planEmbeddingBatches(fresh, this.deps.batch)) {
      const { vectors, tokens } = await embeddings.embed(batch.map((draft) => draft.text));
      progress.tokens += tokens;
      if (vectors.length !== batch.length) throw new EmbeddingProviderError("embedding_bad_response");
      await this.store(transcript, batch, vectors);
      progress.embedded += batch.length;
    }

    // Only a fully embedded transcript drops the passages it no longer has and
    // is stamped as indexed.
    const removed = await prisma.$transaction(async (tx) => {
      const deleted = await tx.$executeRaw`
        DELETE FROM "TranscriptPassage"
        WHERE "transcriptId" = ${transcript.id}::uuid AND "contentHash" <> ALL(${drafts.map((draft) => draft.contentHash)}::text[])`;
      await tx.$executeRaw`
        UPDATE "Transcript"
        SET "passagesIndexedFor" = ${transcript.completedAt}, "passagesAttempts" = 0, "passagesRetryAt" = NULL, "passagesIndexError" = NULL
        WHERE id = ${transcript.id}::uuid`;
      return deleted;
    });
    this.log({
      level: "info", message: "library_passages_indexed", transcriptId: transcript.id, projectId: transcript.projectId,
      workspaceId: transcript.workspaceId, passages: drafts.length, embedded: fresh.length, removed, model: embeddings.model,
      tokens: progress.tokens, durationMs: Date.now() - started,
    });
  }

  private async store(transcript: ClaimedTranscript, batch: readonly TranscriptPassageDraft[], vectors: readonly number[][]) {
    const rows = batch.map((draft, index) =>
      Prisma.sql`(${randomUUID()}::uuid, ${transcript.workspaceId}::uuid, ${transcript.projectId}::uuid, ${transcript.id}::uuid,
        ${draft.startMs}::int, ${draft.endMs}::int, ${draft.text}, ${vectorLiteral(vectors[index]!)}::vector, ${this.deps.embeddings.model}, ${draft.contentHash})`);
    await this.deps.prisma.$executeRaw`
      INSERT INTO "TranscriptPassage" ("id", "workspaceId", "projectId", "transcriptId", "startMs", "endMs", "text", "embedding", "embeddingModel", "contentHash")
      VALUES ${Prisma.join(rows)}
      ON CONFLICT ("transcriptId", "contentHash") DO UPDATE SET "embedding" = EXCLUDED."embedding", "embeddingModel" = EXCLUDED."embeddingModel"`;
  }

  private async retryLater(transcript: ClaimedTranscript, error: unknown, progress: IndexProgress) {
    const code = error instanceof EmbeddingProviderError ? error.code : error instanceof Error ? error.name : "unknown";
    const abandoned = transcript.attempts >= MAX_INDEX_ATTEMPTS;
    const seconds = Math.min(RETRY_BASE_SECONDS * 2 ** Math.max(transcript.attempts - 1, 0), RETRY_MAX_SECONDS);
    await this.deps.prisma.$executeRaw`
      UPDATE "Transcript"
      SET "passagesIndexError" = ${code},
          "passagesRetryAt" = ${abandoned ? Prisma.sql`NULL` : Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${seconds}::double precision)`}
      WHERE id = ${transcript.id}::uuid`;
    this.log({
      level: abandoned ? "error" : "warn", message: abandoned ? "library_passages_index_abandoned" : "library_passages_index_failed",
      transcriptId: transcript.id, projectId: transcript.projectId, workspaceId: transcript.workspaceId, attempts: transcript.attempts,
      ...(abandoned ? {} : { retryInSeconds: seconds }), code, embeddedBeforeFailure: progress.embedded, tokens: progress.tokens,
    });
  }
}
