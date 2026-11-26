import { describe, expect, test } from "bun:test";
import { sessionTokenClaims, sessionTokenSubject } from "./session-token";

const base64url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
};
const jwt = (payload: string): string => `${base64url('{"alg":"RS256"}')}.${base64url(payload)}.sig`;

describe("session token claims", () => {
  test("reads sub from a base64url JWT payload, including multi-byte claims", () => {
    const token = jwt(JSON.stringify({ sub: "user_2abc", name: "Zoë ✓ 東京", pad: "??>>" }));
    expect(sessionTokenSubject(token)).toBe("user_2abc");
    expect(sessionTokenClaims(token)?.name).toBe("Zoë ✓ 東京");
  });

  test("accepts standard base64 and padding", () => {
    const payload = btoa(JSON.stringify({ sub: "user_x", q: "??>>" }));
    expect(sessionTokenSubject(`h.${payload}.s`)).toBe("user_x");
  });

  test("anything unreadable is null", () => {
    for (const token of [
      "token",
      "a.b",
      "a..c",
      "a.!!!.c",
      "a.b.c.d",
      jwt("not json"),
      jwt("[1,2]"),
      jwt("null"),
      jwt('{"sub":42}'),
      jwt('{"sub":""}'),
      `h.${base64url('{"sub":"u"}')}x.s`,
    ]) {
      expect(sessionTokenSubject(token)).toBeNull();
    }
  });
});
