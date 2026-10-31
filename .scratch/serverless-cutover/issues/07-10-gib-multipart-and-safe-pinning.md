# 07 - 10 GiB multipart and safe pinning

**What to build:** 10 GiB multipart and safe pinning.

**Blocked by:** 06, 09

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.8 across browser, REST, MCP and CLI. Large conditional-read pin job. Exact recovery and cleanup. Transfer separated from signing.
- **Files:** `packages/validators/src/upload.ts`, `packages/services/src/{upload-session.service,r2-storage,ingest-job-lifecycle}.ts`, `apps/media/src/source-pin.ts`, ingest/REST/MCP adapters, `apps/mcp/src/upload.ts`, `packages/mcp-core` upload tools, `packages/api-client/src/ingest/**`, web upload, OpenAPI/docs.
- **Accept:** a 10 GiB auto transfer works with bounded memory, and >10 GiB is refused. A >5 GiB pin works without conditional `UploadPartCopy`. Overwrite, lost finalize, mutation during pin, abort and expired grants all behave per ADR 0005.

## Evidence

Pending implementation and verification.
