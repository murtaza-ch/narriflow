import { describe, expect, test } from "bun:test";
import { driveFileMediaUrl } from "@narriflow/services/drive-source";
import { guardedFetch, type PinnedTransport } from "./outbound-transport";
const FILE_ID="1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123";
const TOKEN="ya29.fake-native-download-token";
const resolver=async()=>[{address:"142.250.80.42",family:4}];
describe("Drive download credentials", () => {
  test("guardedFetch drops Authorization when a redirect leaves the Drive origin", async () => {
    const seen: Array<{ url: URL; authorization: string | null }> = [];
    const transport: PinnedTransport = async (url, request) => {
      seen.push({ url, authorization: request.headers.get("authorization") });
      if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/drive/v3/files/")) {
        return new Response(null, { status: 302, headers: { location: "https://lh3.googleusercontent.com/dl/abc" } });
      }
      return new Response("video bytes", { status: 200, headers: { "content-type": "video/mp4" } });
    };
    const response = await guardedFetch(driveFileMediaUrl(FILE_ID), {
      headers: { authorization: `Bearer ${TOKEN}` },
      transport,
      resolver,
    });
    expect(response.status).toBe(200);
    expect(seen.map((request) => request.url.hostname)).toEqual(["www.googleapis.com", "lh3.googleusercontent.com"]);
    expect(seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[1]!.authorization).toBeNull();
  });

  test("a redirect within the Drive API origin keeps it", async () => {
    const seen: Array<string | null> = [];
    const transport: PinnedTransport = async (url, request) => {
      seen.push(request.headers.get("authorization"));
      return url.pathname.startsWith("/drive/v3/")
        ? new Response(null, { status: 307, headers: { location: "https://www.googleapis.com/download/drive/v3/files/x" } })
        : new Response("ok", { status: 200 });
    };
    await guardedFetch(driveFileMediaUrl(FILE_ID), {
      headers: { authorization: `Bearer ${TOKEN}` },
      transport,
      resolver,
    });
    expect(seen).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });
});

