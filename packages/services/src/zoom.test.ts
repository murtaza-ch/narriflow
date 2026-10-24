import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { assertZoomDownloadUrl, createZoomTokenCipher, parseZoomNotification, selectZoomRecording, verifyZoomSignature, zoomRecordingIdentity, zoomRecordingPath, zoomValidationChallenge, ZOOM_SCOPES } from "./zoom";
import { createZoomApi } from "./zoom-api";

describe("Zoom webhook contract", () => {
  // Message and plainToken follow https://developers.zoom.us/docs/api/webhooks/.
  // Fixed hashes were calculated independently with Python's hmac/sha256.
  const docBody = '{"event":"session.started","payload":{"account_id":"{ACCOUNT_ID}","object":{"start_time":"2022-07-27T16:56:34Z","id":"{SESSION_ID}"}},"event_ts":1658940994914}';
  const signature = "v0=98cf0e8dc54770331ded5977bb176d6a1811b0a8d0afe07449f37f58da31623e";
  const signed = { rawBody: docBody, timestamp: "1658940994", signature, secret: "webhook_secret", nowMs: 1658940994000 };
  test("the documented v0 message uses HMAC-SHA256 over the original body", () => {
    expect(() => verifyZoomSignature(signed)).not.toThrow();
    for (const change of [{ rawBody: `${docBody}\n` }, { signature: "v0=wrong" }, { timestamp: null }, { secret: "other" }, { nowMs: signed.nowMs + 300001 }, { nowMs: signed.nowMs - 300001 }])
      expect(() => verifyZoomSignature({ ...signed, ...change })).toThrow();
  });
  test("the URL challenge hashes only the plainToken", () => {
    expect(zoomValidationChallenge("qgg8vlvZRS6UYooatFL8Aw", "webhook_secret")).toEqual({ plainToken: "qgg8vlvZRS6UYooatFL8Aw", encryptedToken: "4eb3e791eff1f402d8d99a140679c2ff8ea349674fc45c906f7442be72bda568" });
    expect(() => zoomValidationChallenge({}, "secret")).toThrow();
  });
  const files = [
    { id: "audio", file_type: "M4A", status: "completed" },
    { id: "speaker", file_type: "MP4", status: "completed", recording_type: "speaker_view" },
    { id: "screen", file_type: "MP4", status: "completed", recording_type: "shared_screen_with_speaker_view" },
  ];
  test("only completed MP4 files qualify and shared screen with speaker wins", () => {
    expect(selectZoomRecording(files)?.id).toBe("screen");
    expect(selectZoomRecording([{ ...files[2]!, status: "processing" }])).toBeNull();
    expect(selectZoomRecording([files[0]!])).toBeNull();
  });
  test("a recording event stores IDs and metadata, discarding tokens and URLs", () => {
    const event = { event: "recording.completed", event_ts: 1658940994914, download_token: "private", payload: { account_id: "account", object: { uuid: "/meeting//", host_id: "host", topic: "Webinar", duration: 60, password: "private", recording_files: files.map((file) => ({ ...file, download_url: "https://zoom.us/private?token=secret" })) } } };
    const parsed = parseZoomNotification(event)!;
    expect(parsed.notification).toEqual({ event: "recording.completed", eventTs: event.event_ts, accountId: "account", hostId: "host", meetingUuid: "/meeting//", recordingId: "screen", topic: "Webinar", durationSeconds: 3600 });
    expect(JSON.stringify(parsed)).not.toContain("private");
    expect(parseZoomNotification({ ...event, event_ts: event.event_ts + 1000 })?.eventKey).toBe(parsed.eventKey);
    expect(parseZoomNotification({ event: "meeting.started" })).toBeNull();
    expect(() => parseZoomNotification({ ...event, payload: {} })).toThrow();
  });
  test("recording identity and Zoom's special UUID encoding are unambiguous", () => {
    expect(zoomRecordingIdentity("a:b", "c")).not.toBe(zoomRecordingIdentity("a", "b:c"));
    expect(zoomRecordingPath("/foo//bar==")).toBe("/meetings/%252Ffoo%252F%252Fbar%253D%253D/recordings");
    expect(zoomRecordingPath("abc/def=")).toBe("/meetings/abc%2Fdef%3D/recordings");
  });
  test("the bearer token can only be sent to HTTPS Zoom hosts", () => {
    expect(assertZoomDownloadUrl("https://us02web.zoom.us/rec/download/file")).toBe("https://us02web.zoom.us/rec/download/file");
    for (const url of ["http://zoom.us/rec", "https://zoom.us.evil.test/rec", "https://evil.test/", "https://user:password@zoom.us/rec", "https://zoom.us:444/rec"])
      expect(() => assertZoomDownloadUrl(url)).toThrow();
  });
  test("sealed tokens are authenticated and a wrong key can't open them", () => {
    const cipher = createZoomTokenCipher("test key"), token = cipher.seal("private-access");
    expect(token).not.toContain("private-access");
    expect(cipher.open(token)).toBe("private-access");
    expect(() => createZoomTokenCipher("wrong").open(token)).toThrow();
  });
});

describe("Zoom API", () => {
  test("token exchange uses a form body and rejects missing scopes without exposing response data", async () => {
    let seenUrl = "", seenBody = "";
    const transport = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url); seenBody = String(init?.body);
      return Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, scope: ZOOM_SCOPES.join(" ") });
    }) as typeof fetch;
    const api = createZoomApi({ clientId: "client", clientSecret: "secret" }, transport);
    expect((await api.exchange("private-code", "https://app.test/api/zoom/oauth/callback")).access_token).toBe("private-access");
    expect(seenUrl).toBe("https://zoom.us/oauth/token");
    expect(new URLSearchParams(seenBody).get("code")).toBe("private-code");
    const refused = createZoomApi({ clientId: "client", clientSecret: "secret" }, (async () => Response.json({ secret: "do-not-repeat" }, { status: 401 })) as typeof fetch);
    await expect(refused.refresh("private-refresh")).rejects.toMatchObject({ code: "zoom_connection_unavailable" });
  });
  test("recording resolution verifies meeting, host, file and media type", async () => {
    const response = { uuid: "meeting", host_id: "host", recording_files: [{ id: "file", status: "completed", file_type: "MP4", download_url: "https://us02web.zoom.us/rec/download/private" }] };
    const api = createZoomApi({ clientId: "client", clientSecret: "secret" }, (async () => Response.json(response)) as typeof fetch);
    expect(await api.recording("access", "meeting", "file", "host")).toContain("zoom.us/rec/");
    await expect(api.recording("access", "meeting", "file", "other-host")).rejects.toMatchObject({ code: "zoom_recording_unavailable" });
    await expect(api.recording("access", "meeting", "another-file", "host")).rejects.toMatchObject({ code: "zoom_recording_unavailable" });
  });
  test("raw formatting remains signed when there is whitespace", () => {
    const body = '{ "event": "meeting.started" }', timestamp = "1658940994", secret = "secret";
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    expect(() => verifyZoomSignature({ rawBody: body, timestamp, signature, secret, nowMs: Number(timestamp) * 1000 })).not.toThrow();
  });
});
