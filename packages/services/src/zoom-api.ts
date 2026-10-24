import { zoomTokenResponseSchema, zoomUserResponseSchema, zoomMeetingRecordingsSchema, type ZoomTokens } from "@narriflow/validators";
import { readResponseTextBounded } from "./url-guard";
import { assertZoomDownloadUrl, ZOOM_SCOPES, ZoomError, zoomRecordingPath } from "./zoom";

export interface ZoomApi {
  exchange(code: string, redirectUri: string): Promise<ZoomTokens>;
  refresh(refreshToken: string): Promise<ZoomTokens>;
  me(accessToken: string): Promise<{ id: string; account_id: string; displayName: string }>;
  recording(accessToken: string, meetingUuid: string, recordingId: string, hostId: string): Promise<string>;
  revoke(accessToken: string): Promise<void>;
}

export function createZoomApi(config: { clientId: string; clientSecret: string }, transport: typeof fetch = fetch): ZoomApi {
  const basic = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  async function request(url: string, init: RequestInit, oauth = false): Promise<unknown> {
    let response: Response;
    try { response = await transport(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
    catch { throw new ZoomError("zoom_api_unavailable"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 429 || response.status >= 500) throw new ZoomError("zoom_api_unavailable");
      if (oauth || response.status === 401) throw new ZoomError("zoom_connection_unavailable");
      throw new ZoomError("zoom_recording_unavailable");
    }
    try { return JSON.parse(await readResponseTextBounded(response, 2 * 1024 * 1024)); }
    catch { throw new ZoomError("zoom_api_unavailable"); }
  }
  async function token(params: Record<string, string>) {
    const result = zoomTokenResponseSchema.safeParse(await request("https://zoom.us/oauth/token", { method: "POST", headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }, true));
    if (!result.success || !ZOOM_SCOPES.every((scope) => result.data.scope.split(" ").includes(scope))) throw new ZoomError("zoom_connection_unavailable");
    return result.data;
  }
  return {
    exchange: (code, redirectUri) => token({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),
    async me(accessToken) {
      const result = zoomUserResponseSchema.safeParse(await request("https://api.zoom.us/v2/users/me", { headers: { authorization: `Bearer ${accessToken}` } }));
      if (!result.success) throw new ZoomError("zoom_oauth_failed");
      return { ...result.data, displayName: result.data.display_name || [result.data.first_name, result.data.last_name].filter(Boolean).join(" ") || "Zoom user" };
    },
    async recording(accessToken, meetingUuid, recordingId, hostId) {
      const result = zoomMeetingRecordingsSchema.safeParse(await request(`https://api.zoom.us/v2${zoomRecordingPath(meetingUuid)}`, { headers: { authorization: `Bearer ${accessToken}` } }));
      if (!result.success || result.data.uuid !== meetingUuid || result.data.host_id !== hostId) throw new ZoomError("zoom_recording_unavailable");
      const file = result.data.recording_files.find((entry) => entry.id === recordingId && entry.status === "completed" && entry.file_type.toUpperCase() === "MP4");
      return assertZoomDownloadUrl(file?.download_url);
    },
    async revoke(accessToken) {
      await request("https://zoom.us/oauth/revoke", { method: "POST", headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: accessToken }).toString() }, true);
    },
  };
}
