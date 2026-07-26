import { describe, expect, test } from "bun:test";
import {
  createUploadFileFingerprint,
  decideUploadInitialization,
  LEGACY_UPLOAD_RESUME_STORAGE_KEYS,
  loadUploadResume,
  parseStoredUploadResume,
  parseUploadInitialization,
  safelyGetUploadResumeStorage,
  saveUploadResume,
  UPLOAD_RESUME_STORAGE_KEY,
  UPLOAD_RESUME_VERSION,
  validateMultipartEtags,
  type UploadResumeSession,
} from "./upload-resume";

const FUTURE = "2026-07-11T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function validSession(
  overrides: Partial<UploadResumeSession> = {},
): UploadResumeSession {
  return {
    version: UPLOAD_RESUME_VERSION,
    fingerprint: "fingerprint-a",
    projectId: PROJECT_ID,
    uploadId: UPLOAD_ID,
    key: `projects/${PROJECT_ID}/video.mp4`,
    fileName: "video.mp4",
    title: "Video",
    partCount: 2,
    expiresAt: FUTURE,
    ...overrides,
  };
}

function activeInitialization() {
  return {
    outcome: "active",
    projectId: PROJECT_ID,
    uploadId: UPLOAD_ID,
    key: `projects/${PROJECT_ID}/video.mp4`,
    partCount: 2,
    uploadUrls: [{ partNumber: 2, url: "https://uploads.example/part-2" }],
    alreadyUploadedPartNumbers: [1],
    alreadyUploadedParts: [{ partNumber: 1, etag: "etag-1" }],
    expiresAt: FUTURE,
  };
}

describe("upload resume storage", () => {
  test("fingerprints the exact current file metadata", () => {
    const base = {
      name: "video.mp4",
      size: 123,
      type: "video/mp4",
      lastModified: 456,
    };
    expect(createUploadFileFingerprint(base)).not.toBe(
      createUploadFileFingerprint({ ...base, type: "audio/mp4" }),
    );
    expect(createUploadFileFingerprint(base)).not.toBe(
      createUploadFileFingerprint({ ...base, size: 124 }),
    );
  });

  test("discards legacy, corrupt and other-file records", () => {
    expect(
      parseStoredUploadResume(
        JSON.stringify({ ...validSession(), version: 1 }),
        "fingerprint-a",
      ),
    ).toEqual({ kind: "discard", reason: "legacy" });
    expect(parseStoredUploadResume("{", "fingerprint-a")).toEqual({
      kind: "discard",
      reason: "corrupt",
    });
    expect(
      parseStoredUploadResume(
        JSON.stringify(validSession({ expiresAt: "not-a-date" })),
        "fingerprint-a",
      ),
    ).toEqual({ kind: "discard", reason: "corrupt" });
    expect(
      parseStoredUploadResume(
        JSON.stringify(validSession()),
        "fingerprint-b",
      ),
    ).toEqual({ kind: "discard", reason: "other_file" });
  });

  test("keeps an exact-fingerprint expired record for server reconciliation", () => {
    const storage = new MemoryStorage();
    const expiredSession = validSession({ expiresAt: PAST });
    storage.setItem(
      UPLOAD_RESUME_STORAGE_KEY,
      JSON.stringify(expiredSession),
    );

    expect(loadUploadResume(storage, "fingerprint-a")).toEqual(
      expiredSession,
    );
    expect(storage.getItem(UPLOAD_RESUME_STORAGE_KEY)).not.toBeNull();
  });

  test("clears discarded and legacy records", () => {
    const storage = new MemoryStorage();
    storage.setItem(UPLOAD_RESUME_STORAGE_KEY, "{");
    storage.setItem(LEGACY_UPLOAD_RESUME_STORAGE_KEYS[0], "legacy");

    expect(loadUploadResume(storage, "fingerprint-a")).toBeNull();
    expect(storage.getItem(UPLOAD_RESUME_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_UPLOAD_RESUME_STORAGE_KEYS[0])).toBeNull();
  });

  test("never lets storage exceptions block a fresh upload", () => {
    const storage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };

    expect(loadUploadResume(storage, "fingerprint-a")).toBeNull();
    expect(() => saveUploadResume(storage, validSession())).not.toThrow();
    expect(() => saveUploadResume(storage, null)).not.toThrow();
  });

  test("never lets a localStorage getter exception block a fresh upload", () => {
    const source = {
      get localStorage(): Storage {
        throw new DOMException("Access denied", "SecurityError");
      },
    };

    expect(
      safelyGetUploadResumeStorage(() => source.localStorage),
    ).toBeNull();
  });
});

describe("upload initialization decisions", () => {
  test("accepts active and completed outcomes", () => {
    expect(parseUploadInitialization(activeInitialization(), 2)).toEqual({
      ...activeInitialization(),
      uploadUrls: [{ partNumber: 2, url: "https://uploads.example/part-2" }],
      alreadyUploadedPartNumbers: [1],
      alreadyUploadedParts: [{ partNumber: 1, etag: "etag-1" }],
    });
    expect(
      parseUploadInitialization(
        { outcome: "completed", projectId: PROJECT_ID },
        2,
      ),
    ).toEqual({ outcome: "completed", projectId: PROJECT_ID });
  });

  test("accepts an active server response despite a client clock ahead of expiry", () => {
    const response = {
      ...activeInitialization(),
      expiresAt: PAST,
    };

    expect(parseUploadInitialization(response, 2)).toEqual(response);
  });

  test.each([
    [
      "missing part",
      { ...activeInitialization(), uploadUrls: [] },
    ],
    [
      "duplicate completed part",
      {
        ...activeInitialization(),
        alreadyUploadedPartNumbers: [1, 1],
      },
    ],
    [
      "overlapping pending part",
      {
        ...activeInitialization(),
        uploadUrls: [{ partNumber: 1, url: "https://uploads.example/part-1" }],
      },
    ],
    [
      "invalid URL",
      {
        ...activeInitialization(),
        uploadUrls: [{ partNumber: 2, url: "not-a-url" }],
      },
    ],
    [
      "invalid expiry",
      {
        ...activeInitialization(),
        expiresAt: "not-a-date",
      },
    ],
    ["wrong part count", { ...activeInitialization(), partCount: 3 }],
  ])("rejects %s metadata", (_label, payload) => {
    expect(parseUploadInitialization(payload, 2)).toBeNull();
  });

  test("only chooses a fresh attempt for the explicit stale-session response", () => {
    expect(
      decideUploadInitialization({
        responseOk: false,
        hadResumeSession: true,
        payload: { error: "upload_session_unavailable" },
        expectedPartCount: 2,
      }),
    ).toEqual({ kind: "fresh" });
    expect(
      decideUploadInitialization({
        responseOk: false,
        hadResumeSession: false,
        payload: { error: "upload_session_unavailable" },
        expectedPartCount: 2,
      }),
    ).toEqual({ kind: "error", message: "upload_session_unavailable" });
    expect(
      decideUploadInitialization({
        responseOk: false,
        hadResumeSession: true,
        payload: { error: "upload_presign_failed", message: "Try again." },
        expectedPartCount: 2,
      }),
    ).toEqual({ kind: "error", message: "Try again." });
    expect(
      decideUploadInitialization({
        responseOk: false,
        hadResumeSession: true,
        payload: {
          error: "upload_completion_reconciliation_required",
          message: "Don't start another upload.",
        },
        expectedPartCount: 2,
      }),
    ).toEqual({
      kind: "error",
      message: "Don't start another upload.",
    });
  });

  test("routes valid server outcomes without mutation decisions", () => {
    expect(
      decideUploadInitialization({
        responseOk: true,
        hadResumeSession: true,
        payload: { outcome: "completed", projectId: PROJECT_ID },
        expectedPartCount: 2,
      }),
    ).toEqual({ kind: "completed", projectId: PROJECT_ID });
    expect(
      decideUploadInitialization({
        responseOk: true,
        hadResumeSession: true,
        payload: activeInitialization(),
        expectedPartCount: 2,
      }).kind,
    ).toBe("active");
  });
});

describe("multipart ETag validation", () => {
  test("requires one unique ETag for every part", () => {
    expect(
      validateMultipartEtags(
        [
          [2, "etag-2"],
          [1, "etag-1"],
        ],
        2,
      ),
    ).toEqual([
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "etag-2" },
    ]);
    expect(validateMultipartEtags([[1, "etag-1"]], 2)).toBeNull();
    expect(
      validateMultipartEtags(
        [
          [1, "etag-1"],
          [1, "etag-again"],
        ],
        1,
      ),
    ).toBeNull();
  });
});
