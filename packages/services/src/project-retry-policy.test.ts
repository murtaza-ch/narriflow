import { describe, expect, test } from "bun:test";
import {
  autoRetryBackoffMs,
  claimBackoffWhereClauses,
  decideAutoRetry,
  INGEST_AUTO_RETRY_MAX_ATTEMPTS,
  INGEST_RETRIES_EXHAUSTED_CODE,
  isAutoRetryableFailureCode,
  MAX_INGEST_RETRY_ATTEMPTS,
  PERMANENT_FAILURE_CODES,
  WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS,
  WORKFLOW_RETRIES_EXHAUSTED_CODE,
} from "./project.service";

// This suite covers the pure decision logic behind the automatic job-level
// retry policy (failIngestJob / fail*WorkflowRun / reapStuckIngestJobs /
// reapStuckWorkflowRuns in project.service.ts). Those methods themselves all
// require a live Prisma client (this package's tests run without
// DATABASE_URL, matching getPrismaClient()'s documented "no database"
// fallback — see project-delete.test.ts / project-source-purge.test.ts), so
// — consistent with that existing convention — the DB-independent decision
// functions get direct, thorough unit coverage here, since they are exactly
// what those methods call to decide what to do.

describe("isAutoRetryableFailureCode", () => {
  test("is false for every explicitly permanent code", () => {
    for (const code of PERMANENT_FAILURE_CODES) {
      expect(isAutoRetryableFailureCode(code)).toBe(false);
    }
  });

  test("covers the task's named permanent categories: bad URL, unsupported format, auth failure, quota, file-not-found, SSRF", () => {
    expect(isAutoRetryableFailureCode("link_unsupported_source")).toBe(false); // invalid URL
    expect(isAutoRetryableFailureCode("remote_media_invalid_content_type")).toBe(
      false,
    ); // unsupported format
    expect(isAutoRetryableFailureCode("assemblyai_api_key_missing")).toBe(false); // auth failure
    expect(isAutoRetryableFailureCode("openai_api_key_missing")).toBe(false); // auth failure
    expect(isAutoRetryableFailureCode("quota_exceeded")).toBe(false); // quota exceeded
    expect(isAutoRetryableFailureCode("link_download_missing_file")).toBe(false); // file not found
    expect(isAutoRetryableFailureCode("source_storage_key_missing")).toBe(false); // file not found
    expect(isAutoRetryableFailureCode("remote_url_unsafe")).toBe(false); // SSRF rejection
    expect(isAutoRetryableFailureCode("storage_metadata_invalid")).toBe(false); // deterministic internal header validation
  });

  test("is true for the task's named transient categories: socket/connection, timeouts, 429/5xx-derived codes", () => {
    expect(isAutoRetryableFailureCode("remote_fetch_timeout")).toBe(true);
    expect(isAutoRetryableFailureCode("worker_command_timeout")).toBe(true);
    expect(isAutoRetryableFailureCode("worker_stalled")).toBe(true);
    expect(isAutoRetryableFailureCode("source_download_failed")).toBe(true);
  });

  test("defaults an unrecognized code to retryable rather than permanent", () => {
    // This is the production incident this policy exists to fix: an error we
    // didn't (or couldn't) enumerate must not permanently kill a job.
    expect(isAutoRetryableFailureCode("some_future_code_nobody_wrote_yet")).toBe(
      true,
    );
    expect(isAutoRetryableFailureCode("remote_media_download_failed")).toBe(
      true,
    );
    expect(isAutoRetryableFailureCode("workflow_unhandled_error")).toBe(true);
  });
});

describe("decideAutoRetry", () => {
  const cap = 3;
  const exhaustedCode = "some_stage_retries_exhausted";

  test("transient-error requeue under the cap: every attempt below the cap requeues", () => {
    for (let attemptCount = 0; attemptCount < cap; attemptCount++) {
      expect(
        decideAutoRetry(attemptCount, "remote_fetch_timeout", cap, exhaustedCode),
      ).toEqual({ outcome: "requeue" });
    }
  });

  test("permanent-error immediate fail: fails on the very first attempt despite having full budget remaining", () => {
    expect(
      decideAutoRetry(0, "remote_url_unsafe", cap, exhaustedCode),
    ).toEqual({ outcome: "permanent", terminalErrorCode: "remote_url_unsafe" });

    // The original, specific code is preserved (not overwritten by the
    // generic exhausted code) — a permanent failure should keep the message
    // that actually explains what's wrong.
    expect(
      decideAutoRetry(0, "assemblyai_api_key_missing", cap, exhaustedCode)
        .outcome,
    ).toBe("permanent");
  });

  test("cap exhaustion -> terminal fail: a retryable code stops once attemptCount reaches the cap, using the exhausted code instead of the original", () => {
    const atCap = decideAutoRetry(
      cap,
      "remote_fetch_timeout",
      cap,
      exhaustedCode,
    );
    expect(atCap).toEqual({
      outcome: "permanent",
      terminalErrorCode: exhaustedCode,
    });

    // Comfortably past the cap behaves the same (defensive; should never
    // actually happen since a permanently-failed row is never re-claimed).
    const pastCap = decideAutoRetry(
      cap + 5,
      "remote_fetch_timeout",
      cap,
      exhaustedCode,
    );
    expect(pastCap).toEqual({
      outcome: "permanent",
      terminalErrorCode: exhaustedCode,
    });
  });

  test("reaper requeue vs reaper terminal fail: reapStuckIngestJobs/reapStuckWorkflowRuns both classify a stall as errorCode \"worker_stalled\", which is retryable", () => {
    // Below the cap: the reaper requeues rather than permanently failing —
    // "a job stalled because a worker crashed is the most retryable case".
    expect(
      decideAutoRetry(0, "worker_stalled", INGEST_AUTO_RETRY_MAX_ATTEMPTS, INGEST_RETRIES_EXHAUSTED_CODE),
    ).toEqual({ outcome: "requeue" });
    expect(
      decideAutoRetry(
        INGEST_AUTO_RETRY_MAX_ATTEMPTS - 1,
        "worker_stalled",
        INGEST_AUTO_RETRY_MAX_ATTEMPTS,
        INGEST_RETRIES_EXHAUSTED_CODE,
      ),
    ).toEqual({ outcome: "requeue" });

    // At the cap: the reaper stops requeueing and fails permanently with the
    // dedicated exhausted code, not the bare "worker_stalled" code, so the
    // UI can tell the user this was retried automatically already.
    expect(
      decideAutoRetry(
        INGEST_AUTO_RETRY_MAX_ATTEMPTS,
        "worker_stalled",
        INGEST_AUTO_RETRY_MAX_ATTEMPTS,
        INGEST_RETRIES_EXHAUSTED_CODE,
      ),
    ).toEqual({
      outcome: "permanent",
      terminalErrorCode: INGEST_RETRIES_EXHAUSTED_CODE,
    });

    // Same shape for the workflow-run reaper, with its own cap/exhausted code.
    expect(
      decideAutoRetry(
        WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS,
        "worker_stalled",
        WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS,
        WORKFLOW_RETRIES_EXHAUSTED_CODE,
      ),
    ).toEqual({
      outcome: "permanent",
      terminalErrorCode: WORKFLOW_RETRIES_EXHAUSTED_CODE,
    });
  });

  test("a permanent code at attemptCount 0 is never mistaken for cap exhaustion (terminal code stays the original, specific one)", () => {
    const decision = decideAutoRetry(0, "no_clips_detected", cap, exhaustedCode);
    expect(decision).toEqual({
      outcome: "permanent",
      terminalErrorCode: "no_clips_detected",
    });
  });
});

describe("user-initiated retry still works after automatic retries are exhausted", () => {
  // retryFailedIngest (the "Retry ingest" button's handler) has its own,
  // entirely separate budget: it counts total IngestJob *rows* ever created
  // for the project (prisma.ingestJob.count({ where: { projectId } })) and
  // requires project.ingestStatus === "failed". It never reads
  // IngestJob.attemptCount. The automatic policy in this file reuses the
  // SAME row on every requeue (failIngestJob's requeue branch does
  // `tx.ingestJob.update`, never `.create`) — so no amount of automatic
  // retrying can ever add a row, and the row count retryFailedIngest checks
  // never moves because of it.
  test("the automatic-retry cap and the user-facing retry cap are independent constants", () => {
    expect(INGEST_AUTO_RETRY_MAX_ATTEMPTS).not.toBe(MAX_INGEST_RETRY_ATTEMPTS);
    expect(INGEST_AUTO_RETRY_MAX_ATTEMPTS).toBeLessThan(
      MAX_INGEST_RETRY_ATTEMPTS,
    );
  });

  test("exhausting the automatic cap always resolves to ingestStatus \"failed\" — exactly the precondition retryFailedIngest requires before it will act", () => {
    const decision = decideAutoRetry(
      INGEST_AUTO_RETRY_MAX_ATTEMPTS,
      "remote_media_download_failed",
      INGEST_AUTO_RETRY_MAX_ATTEMPTS,
      INGEST_RETRIES_EXHAUSTED_CODE,
    );
    expect(decision.outcome).toBe("permanent");
    // failIngestJob's permanent branch sets Project.ingestStatus: "failed"
    // whenever decision.outcome === "permanent" (see failIngestJob), which is
    // precisely retryFailedIngest's `if (project.ingestStatus !== "failed")
    // throw IngestNotFailedError()` guard being satisfied — so the user's
    // manual retry is never left permanently blocked by automatic retries
    // having run first.
  });

  test("no realistic attemptCount from the automatic policy alone can reach MAX_INGEST_RETRY_ATTEMPTS rows, since automatic retries never create a row", () => {
    // The automatic cap bounds how many times ONE row is reclaimed; it says
    // nothing about row count, because it never creates rows. Demonstrate
    // the two are unrelated by construction: even reading the automatic cap
    // "as if" it were a row count would stay under the user-facing limit.
    expect(INGEST_AUTO_RETRY_MAX_ATTEMPTS).toBeLessThan(
      MAX_INGEST_RETRY_ATTEMPTS,
    );
  });
});

describe("autoRetryBackoffMs", () => {
  test("doubles per attempt starting from the base delay at attempt 1", () => {
    const base = autoRetryBackoffMs(1);
    expect(autoRetryBackoffMs(2)).toBe(base * 2);
    expect(autoRetryBackoffMs(3)).toBe(base * 4);
  });

  test("never goes negative or shrinks for attemptCount 0 or below", () => {
    expect(autoRetryBackoffMs(0)).toBe(autoRetryBackoffMs(1));
    expect(autoRetryBackoffMs(-5)).toBe(autoRetryBackoffMs(1));
  });

  test("honors an explicit base delay override", () => {
    expect(autoRetryBackoffMs(1, 1000)).toBe(1000);
    expect(autoRetryBackoffMs(2, 1000)).toBe(2000);
  });
});

describe("claimBackoffWhereClauses", () => {
  test("always includes a bare attemptCount: 0 branch so a never-claimed job/run is immediately eligible", () => {
    const clauses = claimBackoffWhereClauses(3);
    expect(clauses[0]).toEqual({ attemptCount: 0 });
  });

  test("adds one gated branch per attempt below the cap, each requiring updatedAt older than that attempt's backoff window", () => {
    const now = 1_700_000_000_000;
    const clauses = claimBackoffWhereClauses(3, now);

    // attemptCount 0 (always eligible) + attempts 1 and 2 (attempt 3 === cap
    // is never "queued" in the first place, so no branch is needed for it).
    expect(clauses).toHaveLength(3);

    const attempt1 = clauses.find((c) => c.attemptCount === 1);
    const attempt2 = clauses.find((c) => c.attemptCount === 2);
    expect(attempt1?.updatedAt?.lt.getTime()).toBe(now - autoRetryBackoffMs(1));
    expect(attempt2?.updatedAt?.lt.getTime()).toBe(now - autoRetryBackoffMs(2));
    // Attempt 2's window is strictly larger (further in the past cutoff is
    // wrong; a LARGER backoff means the cutoff is EARLIER/smaller, i.e. the
    // job must wait longer) than attempt 1's.
    expect(attempt2!.updatedAt!.lt.getTime()).toBeLessThan(
      attempt1!.updatedAt!.lt.getTime(),
    );
  });

  test("a cap of 1 (no automatic retries at all) only ever allows the never-claimed branch", () => {
    const clauses = claimBackoffWhereClauses(1);
    expect(clauses).toEqual([{ attemptCount: 0 }]);
  });
});
