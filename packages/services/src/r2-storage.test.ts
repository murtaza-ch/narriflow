import { describe, expect, test } from "bun:test";
import { buildAttachmentContentDisposition } from "./r2-storage";

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
