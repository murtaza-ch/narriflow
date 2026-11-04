import { describe, expect, test } from "bun:test";
import {
  abandonedUploadResumes,
  clearUploadResume,
  createPendingUploadResume,
  loadUploadResume,
  markUploadResumeIdle,
  parseStoredUploadResumes,
  saveUploadResume,
  UPLOAD_ACTIVE_WINDOW_MS,
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

function pending(fingerprint = FINGERPRINT) {
  return createPendingUploadResume({ clientIdempotencyKey: CLIENT_KEY, fingerprint, fileName: "source.mp4", title: "Source" });
}

describe("Upload Session browser resume records", () => {
  test("writes a client intent before the server returns a session", () => {
    const storage = memoryStorage();

    saveUploadResume(storage, pending());

    expect(JSON.parse(storage.values.get(UPLOAD_RESUME_STORAGE_KEY)!)).toEqual([{
      version: UPLOAD_RESUME_VERSION,
      clientIdempotencyKey: CLIENT_KEY,
      sessionId: null,
      projectId: null,
      fingerprint: FINGERPRINT,
      fileName: "source.mp4",
      title: "Source",
      openRequest: null,
      transferActiveAt: null,
    }]);
  });

  test("keeps one record per file, so choosing another file loses neither", () => {
    const storage = memoryStorage();
    saveUploadResume(storage, { ...pending(), sessionId: SESSION_ID, projectId: PROJECT_ID });
    saveUploadResume(storage, pending("other-file"));

    expect(loadUploadResume(storage, FINGERPRINT)).toMatchObject({ sessionId: SESSION_ID, projectId: PROJECT_ID });
    expect(loadUploadResume(storage, "other-file")).toMatchObject({ sessionId: null });
    expect(loadUploadResume(storage, "unsaved-file")).toBeNull();

    saveUploadResume(storage, { ...pending("other-file"), title: "Renamed" });
    expect(parseStoredUploadResumes(storage.values.get(UPLOAD_RESUME_STORAGE_KEY)!)).toHaveLength(2);

    clearUploadResume(storage, FINGERPRINT);
    expect(loadUploadResume(storage, FINGERPRINT)).toBeNull();
    clearUploadResume(storage, "other-file");
    expect(storage.values.has(UPLOAD_RESUME_STORAGE_KEY)).toBe(false);
  });

  test("a record is abandoned unless another tab's transfer reported recently", () => {
    const storage = memoryStorage(), now = 10 * UPLOAD_ACTIVE_WINDOW_MS;
    saveUploadResume(storage, pending());
    saveUploadResume(storage, { ...pending("idle") });
    saveUploadResume(storage, { ...pending("live"), transferActiveAt: now - UPLOAD_ACTIVE_WINDOW_MS });
    saveUploadResume(storage, { ...pending("stale"), transferActiveAt: now - UPLOAD_ACTIVE_WINDOW_MS - 1 });

    expect(abandonedUploadResumes(storage, FINGERPRINT, now).map((record) => record.fingerprint)).toEqual(["idle", "stale"]);

    markUploadResumeIdle(storage, "live");
    expect(loadUploadResume(storage, "live")?.transferActiveAt).toBeNull();
  });

  test("drops corrupt and other-version records without exposing provider details", () => {
    expect(parseStoredUploadResumes("not-json")).toEqual([]);
    expect(parseStoredUploadResumes(JSON.stringify({ version: 1, fingerprint: FINGERPRINT }))).toEqual([]);
    expect(
      parseStoredUploadResumes(JSON.stringify([{ version: 1, fingerprint: FINGERPRINT, uploadId: "opaque-provider-id", key: "private/object/key" }])),
    ).toEqual([]);

    const [record] = parseStoredUploadResumes(JSON.stringify([{
      ...pending(),
      providerUploadId: "must-not-survive",
      storageKey: "must/not/survive",
      etags: ["must-not-survive"],
    }]));
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty("providerUploadId");
    expect(record).not.toHaveProperty("storageKey");
    expect(record).not.toHaveProperty("etags");
  });
});
