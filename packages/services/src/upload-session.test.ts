import { describe, expect, test } from "bun:test";
import {
  isMissingMultipartUploadError,
  isMissingObjectError,
  normalizeMultipartParts,
  probeExactUploadObject,
  probeMultipartPartsForResume,
  resolveExistingUploadResume,
  type ExistingUploadSessionFacts,
} from "./project.service";

const NOW = 1_000;
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function sessionFacts(
  overrides: Partial<ExistingUploadSessionFacts> = {},
): ExistingUploadSessionFacts {
  return {
    projectId: PROJECT_ID,
    fileName: "video.mp4",
    partCount: 3,
    status: "initiated",
    expiresAtMs: NOW + 1,
    ...overrides,
  };
}

function requestFor(session: ExistingUploadSessionFacts | null) {
  return {
    session,
    requestedFileName: "video.mp4",
    requestedPartCount: 3,
    nowMs: NOW,
  };
}

describe("provider missing-state classification", () => {
  test("recognizes exact multipart and object missing identifiers", async () => {
    const noSuchUpload = {
      name: "Error",
      code: "NoSuchUpload",
      $metadata: { httpStatusCode: 404 },
    };
    const noSuchKey = {
      name: "Error",
      Code: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    };
    const notFound = {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    };

    expect(isMissingMultipartUploadError(noSuchUpload)).toBe(true);
    expect(isMissingObjectError(noSuchKey)).toBe(true);
    expect(isMissingObjectError(notFound)).toBe(true);
    expect(
      await probeMultipartPartsForResume(async () => {
        throw noSuchUpload;
      }),
    ).toEqual({ kind: "missing" });
    expect(
      await probeExactUploadObject(async () => {
        throw noSuchKey;
      }),
    ).toBe("missing");
  });

  test("propagates NoSuchBucket, unknown and bare 404 errors from both probes", async () => {
    const errors = [
      {
        name: "NotFound",
        code: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      },
      {
        name: "UnknownProviderError",
        code: "Unknown404",
        $metadata: { httpStatusCode: 404 },
      },
      { $metadata: { httpStatusCode: 404 } },
    ];

    for (const error of errors) {
      expect(isMissingMultipartUploadError(error)).toBe(false);
      expect(isMissingObjectError(error)).toBe(false);
      await expect(
        probeMultipartPartsForResume(async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      await expect(
        probeExactUploadObject(async () => {
          throw error;
        }),
      ).rejects.toBe(error);
    }
  });
});

describe("existing upload resume resolution", () => {
  test("returns a matching completed project without any provider probe", async () => {
    let listCalls = 0;
    let headCalls = 0;
    const result = await resolveExistingUploadResume(
      requestFor(
        sessionFacts({ status: "completed", expiresAtMs: NOW - 1 }),
      ),
      {
        async listParts() {
          listCalls += 1;
          return { kind: "missing" };
        },
        async headObject() {
          headCalls += 1;
          return "missing";
        },
      },
    );

    expect(result).toEqual({ kind: "completed", projectId: PROJECT_ID });
    expect(listCalls).toBe(0);
    expect(headCalls).toBe(0);
  });

  test("rejects missing and mismatched bindings without provider probes", async () => {
    let probeCalls = 0;
    const probes = {
      async listParts() {
        probeCalls += 1;
        return { kind: "missing" as const };
      },
      async headObject() {
        probeCalls += 1;
        return "missing" as const;
      },
    };

    for (const input of [
      requestFor(null),
      { ...requestFor(sessionFacts()), requestedFileName: "other.mp4" },
      { ...requestFor(sessionFacts()), requestedPartCount: 2 },
      {
        ...requestFor(sessionFacts({ status: "completed" })),
        requestedFileName: "other.mp4",
      },
    ]) {
      expect(await resolveExistingUploadResume(input, probes)).toEqual({
        kind: "unavailable",
        shouldMarkExpired: false,
      });
    }
    expect(probeCalls).toBe(0);
  });

  test("authorizes fresh only after an expired session's object is definitely missing", async () => {
    let listCalls = 0;
    let headCalls = 0;
    const result = await resolveExistingUploadResume(
      requestFor(sessionFacts({ expiresAtMs: NOW })),
      {
        async listParts() {
          listCalls += 1;
          return { kind: "missing" };
        },
        async headObject() {
          headCalls += 1;
          return "missing";
        },
      },
    );

    expect(result).toEqual({
      kind: "unavailable",
      shouldMarkExpired: true,
    });
    expect(listCalls).toBe(0);
    expect(headCalls).toBe(1);
  });

  test.each([
    ["initiated-expired", { status: "initiated", expiresAtMs: NOW }],
    ["expired", { status: "expired" }],
    ["aborted", { status: "aborted" }],
  ] as const)(
    "reconciles the %s database state when the exact object exists",
    async (_label, overrides) => {
      expect(
        await resolveExistingUploadResume(
          requestFor(sessionFacts(overrides)),
          {
            async listParts() {
              return { kind: "missing" };
            },
            async headObject() {
              return "present";
            },
          },
        ),
      ).toEqual({ kind: "reconciliation_required" });
    },
  );

  test("maps a missing multipart plus existing object to reconciliation", async () => {
    expect(
      await resolveExistingUploadResume(requestFor(sessionFacts()), {
        async listParts() {
          return { kind: "missing" };
        },
        async headObject() {
          return "present";
        },
      }),
    ).toEqual({ kind: "reconciliation_required" });
  });

  test("maps a missing multipart plus missing object to unavailable", async () => {
    expect(
      await resolveExistingUploadResume(requestFor(sessionFacts()), {
        async listParts() {
          return { kind: "missing" };
        },
        async headObject() {
          return "missing";
        },
      }),
    ).toEqual({ kind: "unavailable", shouldMarkExpired: false });
  });

  test("returns a sorted, validated partial provider inventory", async () => {
    expect(
      await resolveExistingUploadResume(requestFor(sessionFacts()), {
        async listParts() {
          return {
            kind: "found",
            parts: [
              { partNumber: 2, etag: "etag-2" },
              { partNumber: 1, etag: "etag-1" },
            ],
          };
        },
        async headObject() {
          return "missing";
        },
      }),
    ).toEqual({
      kind: "active",
      parts: [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 2, etag: "etag-2" },
      ],
    });
  });

  test("treats malformed provider inventory as reconciliation-required", async () => {
    expect(
      await resolveExistingUploadResume(requestFor(sessionFacts()), {
        async listParts() {
          return {
            kind: "found",
            parts: [
              { partNumber: 1, etag: "etag-1" },
              { partNumber: 1, etag: "etag-again" },
            ],
          };
        },
        async headObject() {
          return "missing";
        },
      }),
    ).toEqual({ kind: "reconciliation_required" });
  });

  test("propagates transient list and object probe errors unchanged", async () => {
    const listError = new Error("timeout");
    const headError = new Error("provider unavailable");

    await expect(
      resolveExistingUploadResume(requestFor(sessionFacts()), {
        async listParts() {
          throw listError;
        },
        async headObject() {
          return "missing";
        },
      }),
    ).rejects.toBe(listError);
    await expect(
      resolveExistingUploadResume(
        requestFor(sessionFacts({ expiresAtMs: NOW })),
        {
          async listParts() {
            return { kind: "missing" };
          },
          async headObject() {
            throw headError;
          },
        },
      ),
    ).rejects.toBe(headError);
  });
});

describe("multipart completion part validation", () => {
  test("requires and sorts exactly one non-empty ETag for every part", () => {
    expect(
      normalizeMultipartParts(
        [
          { partNumber: 3, etag: "same-etag" },
          { partNumber: 1, etag: "etag-1" },
          { partNumber: 2, etag: "same-etag" },
        ],
        3,
        "complete",
      ),
    ).toEqual([
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "same-etag" },
      { partNumber: 3, etag: "same-etag" },
    ]);
  });

  test.each([
    ["missing", [{ partNumber: 1, etag: "etag-1" }], 2],
    [
      "duplicate",
      [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 1, etag: "etag-again" },
      ],
      2,
    ],
    [
      "extra",
      [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 2, etag: "etag-2" },
        { partNumber: 3, etag: "etag-3" },
      ],
      2,
    ],
    [
      "out of range",
      [
        { partNumber: 0, etag: "etag-0" },
        { partNumber: 1, etag: "etag-1" },
      ],
      2,
    ],
    [
      "blank ETag",
      [
        { partNumber: 1, etag: "etag-1" },
        { partNumber: 2, etag: "   " },
      ],
      2,
    ],
  ])("rejects the %s completion set", (_label, parts, partCount) => {
    expect(
      normalizeMultipartParts(parts, partCount, "complete"),
    ).toBeNull();
  });

  test.each([0, -1, 1.5])(
    "rejects invalid expected part count %s",
    (partCount) => {
      expect(
        normalizeMultipartParts([], partCount, "complete"),
      ).toBeNull();
    },
  );
});
