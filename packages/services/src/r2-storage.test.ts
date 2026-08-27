import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortMultipartUpload,
  buildAttachmentContentDisposition,
  classifyR2StorageError,
  collectUploadedParts,
  collectExactKeyMultipartUploads,
  createMultipartUpload,
  deleteObject,
  downloadObjectToFile,
  headObject,
  InvalidObjectMetadataError,
  isR2Configured,
  listExactKeyMultipartUploads,
  listObjectPageByPrefix,
  putFileFromPath,
  presignSingleUploadUrl,
  sanitizeObjectMetadata,
} from "./r2-storage";

setDefaultTimeout(60_000);

test("R2 adapter classifies access, missing-object, and cancellation failures", () => {
  expect(
    classifyR2StorageError({
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    }),
  ).toBe("storage_access_denied");
  expect(
    classifyR2StorageError({
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    }),
  ).toBe("storage_object_missing");
  expect(classifyR2StorageError(new DOMException("cancelled", "AbortError"))).toBe(
    "storage_operation_cancelled",
  );
});

test("R2 exact-key recovery follows every provider inventory page", async () => {
  const markers: Array<{
    keyMarker?: string;
    uploadIdMarker?: string;
  }> = [];
  const uploads = await collectExactKeyMultipartUploads(
    "workspaces/ws/upload-sessions/session/source.mp4",
    async (pageMarkers) => {
      markers.push(pageMarkers);
      if (markers.length === 1) {
        return {
          Uploads: [
            {
              Key: "workspaces/ws/upload-sessions/session/source.mp4",
              UploadId: "opaque/first",
            },
            {
              Key: "workspaces/ws/upload-sessions/session/source.mp4.other",
              UploadId: "sibling",
            },
          ],
          IsTruncated: true,
          NextKeyMarker: "next-key",
          NextUploadIdMarker: "next-upload",
        };
      }
      return {
        Uploads: [
          {
            Key: "workspaces/ws/upload-sessions/session/source.mp4",
            UploadId: "opaque/second",
          },
        ],
        IsTruncated: false,
      };
    },
  );

  expect(markers).toEqual([
    {},
    { keyMarker: "next-key", uploadIdMarker: "next-upload" },
  ]);
  expect(uploads.map((upload) => upload.uploadId)).toEqual([
    "opaque/first",
    "opaque/second",
  ]);
});

test("R2 multipart resume follows pagination and preserves malformed provider facts", async () => {
  const markers: Array<string | undefined> = [];
  const parts = await collectUploadedParts(async ({ partNumberMarker }) => {
    markers.push(partNumberMarker);
    return markers.length === 1
      ? {
          Parts: [{ PartNumber: 1, ETag: "etag-1" }],
          IsTruncated: true,
          NextPartNumberMarker: "1",
        }
      : {
          Parts: [
            { PartNumber: 2, ETag: "etag-2" },
            { PartNumber: 0, ETag: "" },
          ],
          IsTruncated: false,
        };
  });

  expect(markers).toEqual([undefined, "1"]);
  expect(parts).toEqual([
    { partNumber: 1, etag: "etag-1" },
    { partNumber: 2, etag: "etag-2" },
    { partNumber: 0, etag: "" },
  ]);
});

describe("buildAttachmentContentDisposition", () => {
  test("forces attachment delivery with ASCII and UTF-8 filename forms", () => {
    expect(buildAttachmentContentDisposition("Résumé final.mp4")).toBe(
      "attachment; filename=\"Resume final.mp4\"; filename*=UTF-8''R%C3%A9sum%C3%A9%20final.mp4",
    );
  });

  test("removes path traversal and header-control characters", () => {
    const value = buildAttachmentContentDisposition(
      "../../unsafe\\name\r\nX-Evil: yes.mp4",
    );
    expect(value).toStartWith("attachment; ");
    expect(value).not.toContain("\r");
    expect(value).not.toContain("\n");
    expect(value).not.toContain("../");
    expect(value).not.toContain("X-Evil:");
  });
});

describe("sanitizeObjectMetadata", () => {
  test("keeps ordinary ASCII values readable", () => {
    expect(
      sanitizeObjectMetadata({ source: "rss", rss_url: "https://feeds.npr.org/..." }),
    ).toEqual({ source: "rss", rss_url: "https://feeds.npr.org/..." });
  });

  test("encodes the Unicode ellipsis that previously crashed RSS uploads", () => {
    const metadata = sanitizeObjectMetadata({
      rss_url: "https://feeds.npr.org/…",
      file_name: "Résumé 🎙️.mp3",
    });

    expect(metadata?.rss_url).toStartWith("b64:");
    expect(metadata?.file_name).toStartWith("b64:");
    for (const value of Object.values(metadata ?? {})) {
      expect(value).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  test("hashes oversized optional values instead of breaking the upload", () => {
    expect(sanitizeObjectMetadata({ source_url: `https://example.com/${"x".repeat(2000)}` }))
      .toEqual({ source_url: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
  });

  test("rejects invalid internal metadata keys before reaching the SDK", () => {
    expect(() => sanitizeObjectMetadata({ "bad header": "value" })).toThrow(
      InvalidObjectMetadataError,
    );
  });
});

test("R2 object operations reject a pre-aborted signal before storage access", async () => {
  const controller = new AbortController();
  const reason = new DOMException("contract cancelled", "AbortError");
  controller.abort(reason);

  await expect(
    putFileFromPath({
      key: "test/clip-render-attempt/aborted/upload.mp4",
      filePath: "/file-is-never-opened.mp4",
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);
  await expect(
    downloadObjectToFile({
      key: "test/clip-render-attempt/aborted/download.mp4",
      filePath: "/file-is-never-created.mp4",
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);
  await expect(
    deleteObject("test/clip-render-attempt/aborted/delete.mp4", {
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);
  await expect(
    listObjectPageByPrefix(
      "test/clip-render-attempt/aborted/",
      100,
      undefined,
      { signal: controller.signal },
    ),
  ).rejects.toBe(reason);
});

const configuredContractPrefix = process.env.R2_CONTRACT_TEST_PREFIX?.trim();
const isolatedContractPrefix =
  configuredContractPrefix?.startsWith("test/") ||
  configuredContractPrefix?.startsWith("tests/")
    ? configuredContractPrefix.replace(/\/+$/, "")
    : null;
const r2ContractTest = isR2Configured() && isolatedContractPrefix ? test : test.skip;

r2ContractTest(
  "R2 object adapter uploads, downloads, lists an isolated prefix, normalizes metadata, and deletes",
  async () => {
    const runId = randomUUID();
    const firstAttemptId = randomUUID();
    const secondAttemptId = randomUUID();
    const prefix = `${isolatedContractPrefix}/clip-render-attempt/${runId}/`;
    const siblingPrefix = `${isolatedContractPrefix}/clip-render-attempt/${runId}-sibling/`;
    const key = `${prefix}9x16-${firstAttemptId}.mp4`;
    const secondAttemptKey = `${prefix}9x16-${secondAttemptId}.mp4`;
    const siblingKey = `${siblingPrefix}render.mp4`;
    const directory = await mkdtemp(join(tmpdir(), "narriflow-r2-contract-"));
    const uploadPath = join(directory, "upload.mp4");
    const downloadPath = join(directory, "download.mp4");
    const activeAbortPath = join(directory, "active-abort.mp4");
    const activeAbortKey = `${prefix}9x16-${randomUUID()}.mp4`;
    const bytes = Buffer.from("isolated clip render contract bytes");

    try {
      await writeFile(uploadPath, bytes);
      await putFileFromPath({
        key,
        filePath: uploadPath,
        contentType: "video/mp4",
        metadata: {
          project_id: "contract-project",
          title: "Résumé 🎙️",
        },
      });
      await putFileFromPath({
        key: siblingKey,
        filePath: uploadPath,
        contentType: "video/mp4",
      });
      await putFileFromPath({
        key: secondAttemptKey,
        filePath: uploadPath,
        contentType: "video/mp4",
      });

      const stored = await headObject(key);
      expect(stored).toMatchObject({
        contentType: "video/mp4",
        sizeBytes: bytes.byteLength,
        metadata: {
          project_id: "contract-project",
          title: sanitizeObjectMetadata({ title: "Résumé 🎙️" })?.title,
        },
      });

      await downloadObjectToFile({ key, filePath: downloadPath });
      expect(await readFile(downloadPath)).toEqual(bytes);

      const firstPage = await listObjectPageByPrefix(prefix, 1);
      expect(firstPage.objects).toHaveLength(1);
      expect(firstPage.objects[0]).toEqual(
        expect.objectContaining({
          key: expect.stringMatching(new RegExp(`^${prefix}`)),
          lastModified: expect.any(Date),
        }),
      );
      expect(firstPage.nextContinuationToken).not.toBeNull();
      const secondPage = await listObjectPageByPrefix(
        prefix,
        1,
        firstPage.nextContinuationToken ?? undefined,
      );
      expect(
        [...firstPage.objects, ...secondPage.objects]
          .map((object) => object.key)
          .sort(),
      ).toEqual([key, secondAttemptKey].sort());

      expect(key).not.toBe(secondAttemptKey);
      expect(key).toEndWith(`9x16-${firstAttemptId}.mp4`);

      await writeFile(activeAbortPath, "");
      await truncate(activeAbortPath, 16 * 1024 * 1024 + 1);
      const controller = new AbortController();
      const activeUpload = putFileFromPath({
        key: activeAbortKey,
        filePath: activeAbortPath,
        contentType: "video/mp4",
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 1);
      await expect(activeUpload).rejects.toMatchObject({ name: "AbortError" });
      expect(
        (await listObjectPageByPrefix(prefix, 100)).objects
          .map((object) => object.key)
          .sort(),
      ).toEqual([key, secondAttemptKey].sort());

      await deleteObject(key);
      await deleteObject(key);
      await deleteObject(secondAttemptKey);
      expect((await listObjectPageByPrefix(prefix, 100)).objects).toEqual([]);
    } finally {
      await Promise.allSettled([
        deleteObject(key),
        deleteObject(secondAttemptKey),
        deleteObject(siblingKey),
        deleteObject(activeAbortKey),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

r2ContractTest(
  "R2 Upload Session adapter supports exact direct PUT verification, overwrite, and idempotent delete",
  async () => {
    const key = `${isolatedContractPrefix}/upload-session/${randomUUID()}/source.wav`;
    const bytes = Buffer.from("direct Upload Session bytes");
    try {
      const url = await presignSingleUploadUrl({
        key,
        contentType: "audio/wav",
        expiresIn: 60,
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "audio/wav" },
          body: bytes,
        });
        expect(response.ok).toBe(true);
        expect(response.headers.get("etag")).toBeTruthy();
      }
      expect(await headObject(key)).toMatchObject({
        sizeBytes: bytes.byteLength,
        contentType: "audio/wav",
      });
      await deleteObject(key);
      await deleteObject(key);
    } finally {
      await deleteObject(key).catch(() => {});
    }
  },
);

r2ContractTest(
  "R2 Upload Session recovery lists one exact key and accepts opaque upload identities",
  async () => {
    const sessionPrefix = `${isolatedContractPrefix}/upload-session/${randomUUID()}`;
    const key = `${sessionPrefix}/source.mp4`;
    const siblingKey = `${key}.other`;
    const created = await createMultipartUpload({
      key,
      contentType: "video/mp4",
    });
    const sibling = await createMultipartUpload({
      key: siblingKey,
      contentType: "video/mp4",
    });
    let discovered: Array<{ uploadId: string }> = [];
    try {
      discovered = await listExactKeyMultipartUploads({ key });
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.uploadId.length).toBeGreaterThan(0);
      expect(discovered[0]?.uploadId.length).toBeLessThanOrEqual(2_048);
      expect(discovered[0]?.uploadId).not.toBe(sibling.uploadId);
      await abortMultipartUpload({ key, uploadId: created.uploadId });
      await abortMultipartUpload({ key, uploadId: created.uploadId });
    } finally {
      await Promise.allSettled([
        abortMultipartUpload({ key, uploadId: created.uploadId }),
        ...discovered.map(({ uploadId }) =>
          abortMultipartUpload({ key, uploadId }),
        ),
        abortMultipartUpload({ key: siblingKey, uploadId: sibling.uploadId }),
      ]);
    }
  },
);
