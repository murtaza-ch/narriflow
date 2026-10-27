# RAG architecture research

Checked 2026-10-13. Scope is an architecture recommendation, not an implementation. Skills read in order: `ecosystem-primer`, `langchain-rag`, `langchain-dependencies`. No established research-note directory was found in `.scratch`, so this note uses `.scratch/research/`.

## Recommendation for Narriflow

Use TypeScript and a fixed two-step pipeline: retrieve authorized source passages, then ask a chat model to answer with citations. Keep the existing Next.js/Hono frontend and API, Clerk identity, Neon Postgres, R2 files, and durable worker infrastructure. Add LangChain's model/embedding adapters and text splitters, plus pgvector in Neon. This recommendation follows the current repository stack and avoids operating another database or a Python service for ordinary text/transcript Q&A.

LangChain's retrieval guide describes two-step RAG as retrieval before generation with predictable control. Agentic RAG lets a model choose when and how to retrieve, with variable latency. Use LangGraph only when measured needs require custom branching, retry loops, stateful workflows, or approval. Deep Agents' planning and delegation are unnecessary for this fixed Q&A pipeline. [LangChain retrieval](https://docs.langchain.com/oss/javascript/deepagents/retrieval)

For a new ingestion-heavy project, Python with FastAPI and LangChain can be a reasonable alternative if the team's preferred document parsing, OCR, and ML tools are Python-based. That is an engineering judgment about integration costs, not evidence that Python gives better RAG answers.

## Verified packages and runtime caveats

- The live LangChain installation page documents Node.js 22+ and provides a Bun installation tab stating Bun 1.0+. The local dependency skill's Node.js 20+ statement is older than this page. [Install guide](https://docs.langchain.com/oss/javascript/langchain/install)
- Current npm metadata still declares `engines.node >=20` for `langchain`, `@langchain/core`, and `@langchain/pgvector`. At verification, versions were `langchain 1.5.16`, `@langchain/core 1.2.17`, and `@langchain/pgvector 0.1.0`. Use Node 22+ for the documented setup, and lock mutually compatible packages rather than copying stale skill version minima. [LangChain registry](https://registry.npmjs.org/langchain/latest), [core registry](https://registry.npmjs.org/@langchain/core/latest), [pgvector registry](https://registry.npmjs.org/@langchain/pgvector/latest)
- The JS pgvector integration page explicitly says it is available only on Node.js. Its setup and imports use the real package `@langchain/pgvector`, with `pg` and `@langchain/core`. The published npm tarball README confirms those imports and dependency requirements. The page also contains a conflicting `@langchain/community` sentence and a comparison table that mixes Python APIs into its JS discussion. Follow the setup and published package rather than that sentence; do not infer JS `PGEngine` or BM25 support from the table. [JS pgvector guide](https://docs.langchain.com/oss/javascript/integrations/vectorstores/pgvector), [published package tarball](https://registry.npmjs.org/@langchain/pgvector/-/pgvector-0.1.0.tgz)
- Core Bun documentation does not establish Bun support for every integration. For existing Bun workers, use the application's database client and a small parameterized SQL retriever, after verifying its Bun behavior. Return LangChain `Document` objects to the generation step. Alternatively, run this integration in a Node 22+ service. This is a compatibility recommendation; no Bun runtime integration test was run.

For the minimal pipeline, the useful packages are `@langchain/core`, `@langchain/openai`, `@langchain/textsplitters`, and optionally `langsmith`. Install `langchain` if using its higher-level APIs or agents. Add `@langchain/pgvector` and `pg` for its documented Node integration. PDF/HTML loaders and their parser dependencies are source-specific, not universal requirements. [Installation](https://docs.langchain.com/oss/javascript/langchain/install), [pgvector setup](https://docs.langchain.com/oss/javascript/integrations/vectorstores/pgvector)

## Data and embeddings

Neon supports pgvector, enabled per database with `CREATE EXTENSION IF NOT EXISTS vector`. Its documentation says the extension is available on every Neon plan. pgvector supplies exact search and approximate HNSW/IVFFlat indexes. HNSW `vector` indexes support up to 2,000 dimensions, so `vector(1536)` is suitable for the proposed embedding default. Add HNSW when corpus size and measured query latency justify it. [Neon pgvector](https://neon.com/docs/extensions/pgvector)

OpenAI `text-embedding-3-small` returns 1,536 dimensions by default. `text-embedding-3-large` defaults to 3,072. The `dimensions` parameter can shorten third-generation embeddings, contrary to the local RAG skill's blanket statement that dimensions cannot be configured. A single embedding input is limited to 8,192 tokens and cannot be empty; the create API also specifies at most 300,000 tokens summed across a request. Keep document and query embeddings on the same model, dimension setting, and preprocessing version. A model change normally requires re-embedding the corpus. [Embedding guide](https://developers.openai.com/api/docs/guides/embeddings), [create embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create)

## Required application behavior

These are design requirements for a reliable multi-tenant app, not mandatory LangChain products:

1. An asynchronous ingestion job extracts text, normalizes it, chunks it, embeds it, and stores text plus vectors. Raw files remain in R2. Videos need transcripts first; scanned PDFs need OCR.
2. Every chunk carries workspace/document identity, source title, page or timestamp, content/version hash, and embedding configuration. Source updates and deletion must update or remove indexed chunks.
3. Retrieval applies workspace and document permissions in the database query before any content reaches the LLM. Identity must come from the authenticated server context.
4. Each answer combines the question with a bounded set of retrieved passages. Cite source IDs tied to actual retrieved metadata, and abstain if available evidence does not support the answer. RAG supplies context at inference time; it does not retrain the model.
5. Define prompt/token budgets, provider rate limits, retries, ingestion status, and request latency/cost tracking. Hosted embedding and chat APIs do not require an application GPU.
6. Start chunk size, overlap, and retrieval `k` as tunable hypotheses. Specify whether the splitter counts characters or tokens; the skill's basic `RecursiveCharacterTextSplitter` examples count characters. Test on actual documents before choosing values.

## Evaluation

LangSmith's official RAG tutorial evaluates answer correctness against reference answers, answer relevance against the question, groundedness against retrieved passages, and retrieval relevance against the question. It provides Python and TypeScript examples. A useful starter dataset should include answerable questions, questions with no answer in the corpus, source updates, and cross-workspace access cases. Add citation validity and retrieval recall checks where expected source chunks are labeled, and measure latency and token cost. [Evaluate a RAG application](https://docs.langchain.com/langsmith/evaluate-rag-tutorial)

## Diagram model

Indexing: `sources -> extract text -> chunks with citations -> embeddings -> Neon text + vectors`.

Answering: `authenticated question -> same embedding model -> authorized vector search -> passages + source metadata -> prompt + chat model -> answer + validated citations`.

The two paths share a vector index. The LLM receives only the retrieved context selected for that request.
