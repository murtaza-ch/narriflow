# 14 - Search the library across transcripts

**What to build:** Search every transcript in a Workspace by meaning and words. Get timestamped moments across Projects, and make a clip from any result.

**Blocked by:** None.

**Status:** done

**Research:** `.scratch/research/rag-architecture.md` (pgvector on Neon, `text-embedding-3-small`, permissions in the query).

## Behavior

- Migration enables `vector` (`CREATE EXTENSION IF NOT EXISTS vector`) and adds `TranscriptPassage`:
  - `workspaceId`, `projectId` (cascade), `transcriptId`, `startMs`, `endMs`, `text`, `embedding vector(1536)`, `embeddingModel`, `contentHash`.
  - Indexes on workspace and an HNSW index.
  - Owner step: the extension must be enabled on the shared database when the migration is applied. Note it in the runbook.
- A worker loop chunks completed transcripts into passages of about 30 to 60 seconds on utterance boundaries, embeds them in batches with `text-embedding-3-small`, and upserts them by content hash. It re-embeds when a transcript changes. Failures retry with backoff and never block generation. Usage is logged for cost.
- Search: `searchLibrary(scope, { query, limit, projectIds? })`.
  - It embeds the query.
  - It runs one SQL query that filters by Workspace and accessible Projects before ranking. Hybrid ranking combines vector distance and Postgres full-text rank.
  - It returns `{ projectId, projectTitle, startMs, endMs, text, score }`.
  - Results are only for Projects the actor can view.
- "Make a clip" from a result creates a clip in that Project at the passage's bounds, through the existing manual clip creation path, then opens it in the Studio.
- UI: a library search page in the app's design language. REST `GET /api/v1/library/search?q=` and MCP `narriflow_search_library` (`projects:read`).
- Docs page.

## Acceptance criteria

- [x] Chunking is deterministic on utterance boundaries (unit tests).
- [x] Search never returns another Workspace's passages (DB test with pgvector on the local Postgres; install the extension locally or skip with a clear message if unavailable).
- [x] Embedding is mocked in tests; no real API calls.
- [x] lint, typecheck, test pass; DB test passes where pgvector exists.

## Comments

2026-10-24: implemented in a worktree, Opus-reviewed (pgvector installed `WITH SCHEMA public` so other gates keep working, `searchText` declared in Prisma, Make-a-clip no longer copies another clip's look or B-roll, token-budgeted batches with incremental upserts and an 8-attempt cap), merged with 01, 03, 06, 10. `prisma migrate diff` shows only the HNSW index Prisma can't express (documented). Verified in the main checkout: biome, typecheck, `bun run test`, all DB gates including library-search (22). The shared database needs the `vector` extension and `OPENAI_API_KEY` on web and worker. Not viewed in a real browser yet.
