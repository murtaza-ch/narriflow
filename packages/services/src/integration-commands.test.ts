import { describe, expect, test } from "bun:test";
import { integrationKeyUuid, integrationUploadSessionKey } from "./integration-commands";

const USER = "00000000-0000-4000-8000-000000000001";

describe("integration key derivation", () => {
  test("matches a reference RFC 9562 UUIDv5 implementation", () => {
    // Python: uuid.uuid5(NAMESPACE, json.dumps([USER, "open_upload", "key-1"], separators=(",", ":")))
    expect(integrationUploadSessionKey(USER, "key-1")).toBe("790b6618-ff64-5dc6-85d6-ca43e6873cc0");
  });

  test("separates users, commands, and caller keys", () => {
    const base = integrationKeyUuid(USER, "generate_clips", "key-1");
    expect(integrationKeyUuid(USER, "generate_clips", "key-1")).toBe(base);
    expect(integrationKeyUuid("00000000-0000-4000-8000-000000000002", "generate_clips", "key-1")).not.toBe(base);
    expect(integrationKeyUuid(USER, "open_upload", "key-1")).not.toBe(base);
    expect(integrationKeyUuid(USER, "generate_clips", "key-2")).not.toBe(base);
    // Tuple serialization is unambiguous across component boundaries.
    expect(integrationKeyUuid(USER, "generate_clips", "a\",\"b")).not.toBe(integrationKeyUuid(USER, "generate_clips", "a"));
  });
});
