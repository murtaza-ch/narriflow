import { Prisma, type PrismaClient } from "@prisma/client";
import {
  LIBRARY_SEARCH_DEFAULT_LIMIT,
  LIBRARY_SEARCH_MAX_LIMIT,
  librarySearchQuerySchema,
  type LibraryPassage,
} from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import { ExpectedDomainFailureError, type ExpectedDomainFailureCatalog } from "./expected-domain-failure";
import type { EmbeddingProvider } from "./openai-embedding-provider";
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
const MAX_QUERY_TERMS = 12;

export interface LibrarySearchDependencies {
  prisma: PrismaClient;
  embeddings: EmbeddingProvider;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
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

/** Search is a request-scoped read. Indexing is driven by exact durable obligations. */
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

}
