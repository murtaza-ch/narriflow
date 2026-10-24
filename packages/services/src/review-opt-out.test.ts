import { describe, expect, test } from "bun:test";
import { signReviewOptOutToken, verifyReviewOptOutToken } from "./review-opt-out";

const SECRET = "opt-out-test-secret-0123456789abcdef";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";

describe("reviewer opt-out tokens", () => {
  test("name the Workspace and the address, lower-cased, and need no login to check", () => {
    const token = signReviewOptOutToken({ workspaceId: WORKSPACE, email: " Client@Example.test " }, SECRET);
    expect(verifyReviewOptOutToken(token, SECRET)).toEqual({ workspaceId: WORKSPACE, email: "client@example.test" });
  });

  test("refuse another secret, an altered payload or signature, and anything malformed", () => {
    const token = signReviewOptOutToken({ workspaceId: WORKSPACE, email: "a@example.test" }, SECRET);
    const [payload, signature] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ w: WORKSPACE, e: "someone-else@example.test" })).toString("base64url");
    for (const bad of [`${token}x`, `${forged}.${signature}`, `${payload}.${signature.slice(1)}A`, payload, "", "a.b.c", `${payload}.`]) {
      expect(verifyReviewOptOutToken(bad, SECRET)).toBeNull();
    }
    expect(verifyReviewOptOutToken(token, "another-secret-0123456789abcdef0123")).toBeNull();
  });
});
