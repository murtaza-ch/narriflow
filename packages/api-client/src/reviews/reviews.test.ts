import { describe, expect, test } from "bun:test";
import { createGuestReviewsClient, reviewQueries } from "./index";

describe("guest review client", () => {
  test("grant queries stay fresh until their advertised expiry without refetching on focus", () => {
    const client = createGuestReviewsClient({ baseUrl: "https://api.example.test", getSession: () => "session" });
    for (const query of [reviewQueries.media(client, "raw-token", "a".repeat(64), "item", "variant"), reviewQueries.share(client, "raw-token", "a".repeat(64))]) {
      expect(query.refetchOnWindowFocus).toBe(false);
      const dataUpdatedAt = Date.now();
      expect(query.staleTime({ state: { data: { expiresAt: new Date(dataUpdatedAt + 900_000).toISOString() }, dataUpdatedAt } })).toBe(870_000);
      expect(query.staleTime({ state: { data: { expiresAt: new Date(dataUpdatedAt + 20_000).toISOString() }, dataUpdatedAt } })).toBe(0);
    }
  });
  test("uses only the guest Bearer, omits cookies, and never retries exchange", async () => {
    const requests: RequestInit[] = [];
    const client = createGuestReviewsClient({ baseUrl: "https://api.example.test", getSession: () => "guest-session", fetch: (async (_url, init) => { requests.push(init!); return Response.json({ sessionToken: "new-session", expiresAt: "2026-10-29T12:00:00.000Z" }); }) as typeof fetch });
    await client.review[":token"].access.$post({ param: { token: "raw-review-token" }, json: { identity: "Client", email: "client@example.test" } });
    expect(requests).toHaveLength(1); expect(requests[0]?.credentials).toBe("omit");
    expect(new Headers(requests[0]?.headers).get("Authorization")).toBe("Bearer guest-session");
    expect(new Headers(requests[0]?.headers).get("X-Workspace-Id")).toBeNull();
  });
  test("clears refused guest sessions with typed errors and separates token-free keys", async () => {
    let refused = 0;
    const client = createGuestReviewsClient({ baseUrl: "https://api.example.test", getSession: () => "expired", onSessionRefused: () => { refused++; }, fetch: (async () => Response.json({ error: "review_session_invalid", message: "Expired", requestId: "request" }, { status: 400 })) as typeof fetch });
    await expect(client.review[":token"].$get({ param: { token: "raw-token" } })).rejects.toMatchObject({ code: "review_session_invalid" });
    expect(refused).toBe(1);
    const digest = "a".repeat(64);
    expect(reviewQueries.guestRoom(client, "raw-token", digest).queryKey).toEqual(["nf-guest", digest, "room"]);
    expect(reviewQueries.share(client, "raw-token", digest).queryKey).toEqual(["nf-share", digest, "export"]);
  });
});
