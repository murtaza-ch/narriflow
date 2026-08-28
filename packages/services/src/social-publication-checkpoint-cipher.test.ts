import { describe, expect, test } from "bun:test";
import {
  createPublicationCheckpointCipher,
  PublicationCheckpointCipherError,
} from "./social-publication-checkpoint-cipher";

describe("publication checkpoint encryption", () => {
  test("round-trips operation state without exposing secrets in ciphertext", () => {
    const cipher = createPublicationCheckpointCipher(
      "checkpoint-test-key-with-at-least-32-characters",
    );
    const state = {
      reconciliationToken: "receiver-token-that-must-remain-secret",
      uploadSession: "https://provider.example/private/session",
    };
    const sealed = cipher.seal(state);

    expect(sealed).toStartWith("v1:");
    expect(sealed).not.toContain(state.reconciliationToken);
    expect(sealed).not.toContain(state.uploadSession);
    expect(cipher.open(sealed)).toEqual(state);
  });

  test("uses fresh authenticated nonces and rejects tampering or the wrong key", () => {
    const cipher = createPublicationCheckpointCipher(
      "checkpoint-test-key-with-at-least-32-characters",
    );
    const other = createPublicationCheckpointCipher(
      "another-checkpoint-key-with-at-least-32-characters",
    );
    const first = cipher.seal({ operationId: "operation-1" });
    const second = cipher.seal({ operationId: "operation-1" });

    expect(second).not.toBe(first);
    expect(() => other.open(first)).toThrow(PublicationCheckpointCipherError);
    expect(() => cipher.open(`${first.slice(0, -1)}A`)).toThrow(
      PublicationCheckpointCipherError,
    );
  });
});
