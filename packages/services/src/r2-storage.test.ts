import { describe, expect, test } from "bun:test";
import {
  buildAttachmentContentDisposition,
  InvalidObjectMetadataError,
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
