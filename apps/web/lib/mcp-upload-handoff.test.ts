import { describe, expect, test } from "bun:test";
import type { verifyMcpUploadHandoff } from "@narriflow/mcp-core";
import { requireMcpUploadHandoffAdmission } from "./mcp-upload-handoff";

const state = { expiresAtMs: 600_000 } as ReturnType<typeof verifyMcpUploadHandoff>;
describe("signed upload handoff admission", () => {
  test("allows an unexpired handoff without looking for previous uploads", async () => {
    let queries = 0;
    await requireMcpUploadHandoffAdmission(state, async () => { queries++; return false; }, 599_999);
    expect(queries).toBe(0);
  });
  test("allows expired handoffs only for an already accepted owned upload", async () => {
    await expect(requireMcpUploadHandoffAdmission(state, async () => false, 600_000)).rejects.toThrow(expect.objectContaining({ code: "mcp_upload_handoff_expired" }));
    await expect(requireMcpUploadHandoffAdmission(state, async () => true, 600_000)).resolves.toBeUndefined();
    await expect(requireMcpUploadHandoffAdmission(state, async () => { throw new Error("Storage unavailable"); }, 600_000)).rejects.toThrow("Storage unavailable");
  });
});
