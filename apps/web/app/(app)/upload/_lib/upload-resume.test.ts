import { describe, expect, test } from "bun:test";
import {
  createPendingUploadResume,
  loadUploadResume,
  parseStoredUploadResume,
  saveUploadResume,
  UPLOAD_RESUME_STORAGE_KEY,
  UPLOAD_RESUME_VERSION,
  type UploadResumeStorage,
} from "./upload-resume";

const CLIENT_KEY = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const FINGERPRINT = '["source.mp4",2048,"video/mp4",42]';

function memoryStorage(): UploadResumeStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("Upload Session browser resume record", () => {
  test("writes a client intent before the server returns a session", () => {
    const record = createPendingUploadResume({
      clientIdempotencyKey: CLIENT_KEY,
      fingerprint: FINGERPRINT,
      fileName: "source.mp4",
      title: "Source",
    });
    const storage = memoryStorage();

    saveUploadResume(storage, record);

    expect(JSON.parse(storage.values.get(UPLOAD_RESUME_STORAGE_KEY)!)).toEqual({
      version: UPLOAD_RESUME_VERSION,
      clientIdempotencyKey: CLIENT_KEY,
      sessionId: null,
      projectId: null,
      fingerprint: FINGERPRINT,
      fileName: "source.mp4",
      title: "Source",
    });
  });

  test("loads the same client key only for the exact selected file", () => {
    const storage = memoryStorage();
    saveUploadResume(storage, {
      ...createPendingUploadResume({
        clientIdempotencyKey: CLIENT_KEY,
        fingerprint: FINGERPRINT,
        fileName: "source.mp4",
        title: "Source",
      }),
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
    });

    expect(loadUploadResume(storage, FINGERPRINT)).toMatchObject({
      clientIdempotencyKey: CLIENT_KEY,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
    });
    expect(loadUploadResume(storage, "other-file")).toBeNull();
    expect(storage.values.has(UPLOAD_RESUME_STORAGE_KEY)).toBe(false);
  });

  test("rejects corrupt and legacy records without exposing provider details", () => {
    expect(parseStoredUploadResume("not-json", FINGERPRINT)).toEqual({
      kind: "discard",
      reason: "corrupt",
    });
    expect(
      parseStoredUploadResume(
        JSON.stringify({
          version: 2,
          fingerprint: FINGERPRINT,
          uploadId: "opaque-provider-id",
          key: "private/object/key",
        }),
        FINGERPRINT,
      ),
    ).toEqual({ kind: "discard", reason: "legacy" });

    const current = JSON.stringify({
      ...createPendingUploadResume({
        clientIdempotencyKey: CLIENT_KEY,
        fingerprint: FINGERPRINT,
        fileName: "source.mp4",
        title: "Source",
      }),
      providerUploadId: "must-not-survive",
      storageKey: "must/not/survive",
      etags: ["must-not-survive"],
    });
    const parsed = parseStoredUploadResume(current, FINGERPRINT);
    expect(parsed.kind).toBe("resume");
    if (parsed.kind !== "resume") throw new Error("expected resume record");
    expect(parsed.record).not.toHaveProperty("providerUploadId");
    expect(parsed.record).not.toHaveProperty("storageKey");
    expect(parsed.record).not.toHaveProperty("etags");
  });
});
