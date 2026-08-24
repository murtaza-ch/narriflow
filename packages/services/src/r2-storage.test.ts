import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAttachmentContentDisposition,
  deleteObject,
  downloadObjectToFile,
  headObject,
  InvalidObjectMetadataError,
  isR2Configured,
  listObjectPageByPrefix,
  putFileFromPath,
  sanitizeObjectMetadata,
} from "./r2-storage";

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

      const listed = await listObjectPageByPrefix(prefix, 100);
      expect(listed.objects.map((object) => object.key)).toEqual([key]);

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
      expect((await listObjectPageByPrefix(prefix, 100)).objects).toEqual([
        expect.objectContaining({ key }),
      ]);

      await deleteObject(key);
      expect((await listObjectPageByPrefix(prefix, 100)).objects).toEqual([]);
    } finally {
      await Promise.allSettled([
        deleteObject(key),
        deleteObject(siblingKey),
        deleteObject(activeAbortKey),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
