import vectors from "./execution-signature.vectors.json";
import { describe, expect, test } from "bun:test";
import { canonicalExecutionTarget, signExecutionRequest, verifyExecutionRequest } from "./execution-signature";

describe("Execution request targets", () => {
  test("canonicalizes query pairs without discarding duplicates or empty values", () => {
    expect(canonicalExecutionTarget("/api/execution/command?space=a+b&a=2&name=%D8%A7%D8%B1%D8%AF%D9%88&a=1")).toBe(
      "/api/execution/command?a=1&a=2&name=%D8%A7%D8%B1%D8%AF%D9%88&space=a%20b",
    );
    expect(canonicalExecutionTarget("/api/command?flag&x=%2b&x=+&=value&&empty=")).toBe("/api/command?=value&empty=&flag=&x=%20&x=%2B");
    expect(canonicalExecutionTarget("/api/%E2%9C%93?%F0%90%80%80=z&%EE%80%80=z")).toBe("/api/%E2%9C%93?%EE%80%80=z&%F0%90%80%80=z");
  });
});

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const body = new TextEncoder().encode('{"action":"acquire"}');
const request = { keyId: "worker-2026-10", key, audience: "executor-control" as const, method: "POST" as const, target: "/api/execution/command?space=a+b&a=2&name=%D8%A7%D8%B1%D8%AF%D9%88&a=1", body, timestamp: 1793440000, deliveryId: "5b3fb350-6604-4886-80d8-78fc5d17608f" };
const signed = {
  version: 1 as const, keyId: "worker-2026-10", audience: "executor-control" as const, method: "POST" as const,
  canonicalTarget: "/api/execution/command?a=1&a=2&name=%D8%A7%D8%B1%D8%AF%D9%88&space=a%20b",
  bodySha256: "97fc4aec7cb88924f37b07fd288eeda37a6f6cbd7c70b4a5a72306f56eb16ff4", timestamp: 1793440000,
  deliveryId: "5b3fb350-6604-4886-80d8-78fc5d17608f", signature: "6480ae33147144162fc48a67b462435c963bdcf9305101dd7d091ce73e4d5905",
};

describe("Execution request signatures", () => {
  test("matches the frozen HMAC vector over the exact raw body and canonical request", async () => {
    expect(await signExecutionRequest(request)).toEqual(signed);
    const whitespace = await signExecutionRequest({ ...request, body: new TextEncoder().encode('{ "action": "acquire" }') });
    expect(whitespace.signature).not.toBe(signed.signature);
  });
});

const verification = { signature: signed, keyRing: new Map([[request.keyId, key]]), audience: request.audience, method: request.method, target: request.target, body, nowSeconds: request.timestamp };

describe("Execution request verification", () => {
  test("returns a stable inbox request digest while accepting the exact clock-window edges", async () => {
    const result = await verifyExecutionRequest(verification);
    expect(result).toEqual({ metadata: signed, requestHash: "ce414e4c29fa0e2aa3f637c9a4441ac2de5c3dce6784eac6b7c87a00cf8227c4" });
    for (const offset of [-300, 300]) {
      expect((await verifyExecutionRequest({ ...verification, nowSeconds: request.timestamp + offset })).metadata).toEqual(signed);
    }
    for (const offset of [-301, 301]) {
      await expect(verifyExecutionRequest({ ...verification, nowSeconds: request.timestamp + offset })).rejects.toMatchObject({ code: "expired" });
    }
  });
});

describe("Execution request rejection", () => {
  test("rejects path aliases and malformed targets before route interpretation", () => {
    for (const target of [
      "https://api.example/api/execution/command", "//api/execution", "/api//execution",
      "/api/./command", "/api/../command", "/api/%2e/command", "/api/%2E%2E/command",
      "/api/%2F/command", "/api/%5C/command", "/api/%252f/command", "/api/%61cquire",
      "/api\\execution", "/api/command#fragment", "/api/command\n", "/api/%00/command",
      "/api/command?x=%", "/api/command?x=%C0%AF", "/api/command?x=%ED%A0%80",
      "/api/command?x=%E2%9C", "/api/command?x=raw space",
    ]) {
      expect(() => canonicalExecutionTarget(target)).toThrow("invalid_target");
    }
  });

  test("binds every security field and refuses changed raw body bytes", async () => {
    const cases = [
      { changes: { body: new TextEncoder().encode('{ "action": "acquire" }') }, code: "body_mismatch" },
      { changes: { audience: "modal-bridge" as const }, code: "wrong_audience" },
      { changes: { method: "GET" }, code: "method_mismatch" },
      { changes: { target: "/api/execution/other" }, code: "target_mismatch" },
      { changes: { target: "/api/execution/command?a=1&a=1&name=%D8%A7%D8%B1%D8%AF%D9%88&space=a+b" }, code: "target_mismatch" },
      { changes: { keyRing: new Map() }, code: "invalid_key" },
      { changes: { keyRing: new Map([[request.keyId, new Uint8Array(32).fill(99)]]) }, code: "signature_mismatch" },
      { changes: { signature: { ...signed, keyId: "retired-key" } }, code: "invalid_key" },
      { changes: { signature: { ...signed, deliveryId: "08ff343c-732d-4495-bc11-d2aa5526545f" } }, code: "signature_mismatch" },
      { changes: { signature: { ...signed, timestamp: signed.timestamp + 1 } }, code: "signature_mismatch" },
      { changes: { signature: { ...signed, signature: "0".repeat(64) } }, code: "signature_mismatch" },
      { changes: { signature: { ...signed, version: 2 } }, code: "invalid_metadata" },
      { changes: { signature: { ...signed, extra: "unused" } }, code: "invalid_metadata" },
      { changes: { signature: { ...signed, canonicalTarget: request.target } }, code: "target_mismatch" },
      { changes: { nowSeconds: Number.NaN }, code: "invalid_clock" },
      { changes: { body: new Uint8Array(65537) }, code: "body_too_large" },
    ];
    for (const { changes, code } of cases) {
      await expect(verifyExecutionRequest({ ...verification, ...changes })).rejects.toMatchObject({ code });
    }
  });

  test("only accepts configured key lengths and bounded commands", async () => {
    for (const length of [0, 31, 65]) {
      await expect(signExecutionRequest({ ...request, key: new Uint8Array(length) })).rejects.toMatchObject({ code: "invalid_key" });
    }
    await expect(signExecutionRequest({ ...request, body: new Uint8Array(65537) })).rejects.toMatchObject({ code: "body_too_large" });
    await expect(signExecutionRequest({ ...request, method: "post" as "POST" })).rejects.toMatchObject({ code: "invalid_metadata" });
  });
});

describe("Cross-language known-answer protocol vectors", () => {
  test("signs and verifies the same frozen metadata and inbox hash as Python", async () => {
    for (const vector of vectors.vectors) {
      const key = Uint8Array.from(vector.keyHex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
      const body = Uint8Array.from(vector.request.bodyHex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
      const metadata = vector.expected.metadata;
      const signature = await signExecutionRequest({
        keyId: vector.request.keyId, key, audience: metadata.audience as "executor-control", method: metadata.method as "GET" | "POST",
        target: vector.request.target, body, timestamp: vector.request.timestamp, deliveryId: vector.request.deliveryId,
      });
      expect(signature).toEqual(metadata);
      expect(await verifyExecutionRequest({ signature, keyRing: new Map([[signature.keyId, key]]), audience: signature.audience, method: signature.method, target: vector.request.target, body, nowSeconds: signature.timestamp })).toEqual(vector.expected);
    }
  });

  test("honors active rotation keys without accepting retired keys", async () => {
    const replacement = { ...request, keyId: "worker-next", key: new Uint8Array(64).fill(23) };
    const signature = await signExecutionRequest(replacement);
    const rotated = new Map([[request.keyId, request.key], [replacement.keyId, replacement.key]]);
    expect((await verifyExecutionRequest({ ...verification, signature, keyRing: rotated })).metadata).toEqual(signature);
    expect((await verifyExecutionRequest({ ...verification, keyRing: rotated })).metadata).toEqual(signed);
    rotated.delete(request.keyId);
    await expect(verifyExecutionRequest({ ...verification, keyRing: rotated })).rejects.toMatchObject({ code: "invalid_key" });
  });
});
