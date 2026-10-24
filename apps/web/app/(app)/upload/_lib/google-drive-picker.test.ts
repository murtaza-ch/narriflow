import { describe, expect, test } from "bun:test";
import { GOOGLE_DRIVE_FILE_SCOPE } from "@narriflow/validators";
import { pickDriveVideo, type GoogleApis } from "./google-drive-picker";

const CONFIG = { apiKey: "api-key", clientId: "client-id", appId: "1234567890" };
const TOKEN = "ya29.picker-token";

type TokenOutcome =
  | { response: { access_token?: string; error?: string }; granted?: boolean }
  | { error: { type: string } };

/** Google's two libraries, faked at the seams `pickDriveVideo` uses. */
function google(token: TokenOutcome, chosen: Record<string, unknown> | null) {
  const seen = {
    scope: null as string | null,
    clientId: null as string | null,
    developerKey: null as string | null,
    appId: null as string | null,
    oauthToken: null as string | null,
    views: [] as unknown[],
    features: [] as string[],
    tokenRequested: false,
    pickerOpened: false,
  };
  const apis: GoogleApis = {
    accounts: {
      oauth2: {
        initTokenClient: (config) => {
          seen.scope = config.scope;
          seen.clientId = config.client_id;
          return {
            requestAccessToken: () => {
              seen.tokenRequested = true;
              if ("error" in token) config.error_callback(token.error);
              else config.callback(token.response);
            },
          };
        },
        hasGrantedAllScopes: (_response, ...scopes) =>
          ("response" in token ? token.granted !== false : false) &&
          scopes.includes(GOOGLE_DRIVE_FILE_SCOPE),
      },
    },
    picker: {
      DocsView: class {
        constructor(public viewId: string) {}
      },
      ViewId: { DOCS_VIDEOS: "docs-videos" },
      Feature: { SUPPORT_DRIVES: "sd" },
      Action: { PICKED: "picked", CANCEL: "cancel" },
      Response: { ACTION: "action", DOCUMENTS: "docs" },
      Document: { ID: "id", NAME: "name" },
      PickerBuilder: class {
        private callback: (data: Record<string, unknown>) => void = () => {};
        addView(view: unknown) {
          seen.views.push(view);
          return this;
        }
        enableFeature(feature: string) {
          seen.features.push(feature);
          return this;
        }
        setOAuthToken(value: string) {
          seen.oauthToken = value;
          return this;
        }
        setDeveloperKey(value: string) {
          seen.developerKey = value;
          return this;
        }
        setAppId(value: string) {
          seen.appId = value;
          return this;
        }
        setCallback(callback: (data: Record<string, unknown>) => void) {
          this.callback = callback;
          return this;
        }
        build() {
          return {
            setVisible: () => {
              seen.pickerOpened = true;
              if (chosen) this.callback(chosen);
            },
          };
        }
      },
    },
  };
  return { apis, seen };
}

describe("pickDriveVideo", () => {
  test("opens the sign-in popup synchronously, so the click still counts as the person's own", async () => {
    const { apis, seen } = google({ response: { access_token: TOKEN } }, { action: "cancel" });
    const pending = pickDriveVideo(CONFIG, apis);
    // Before any await: a popup opened later can be blocked by the browser.
    expect(seen.tokenRequested).toBe(true);
    await pending;
  });

  test("asks for the drive.file scope only, opens a video Picker, and returns the chosen file with its token", async () => {
    const { apis, seen } = google(
      { response: { access_token: TOKEN } },
      { action: "picked", docs: [{ id: "file-id-0123456789", name: "Weekly sync.mp4" }] },
    );
    expect(await pickDriveVideo(CONFIG, apis)).toEqual({
      fileId: "file-id-0123456789",
      name: "Weekly sync.mp4",
      accessToken: TOKEN,
    });
    expect(seen).toMatchObject({
      scope: "https://www.googleapis.com/auth/drive.file",
      clientId: "client-id",
      developerKey: "api-key",
      appId: "1234567890",
      oauthToken: TOKEN,
      features: ["sd"],
      pickerOpened: true,
    });
    expect(seen.views).toHaveLength(1);
    expect((seen.views[0] as { viewId: string }).viewId).toBe("docs-videos");
  });

  test("closing or cancelling either window is not an error", async () => {
    const cancelled = google({ response: { access_token: TOKEN } }, { action: "cancel" });
    expect(await pickDriveVideo(CONFIG, cancelled.apis)).toBeNull();

    const popupClosed = google({ error: { type: "popup_closed" } }, null);
    expect(await pickDriveVideo(CONFIG, popupClosed.apis)).toBeNull();
    expect(popupClosed.seen.pickerOpened).toBe(false);

    const denied = google({ response: { error: "access_denied" } }, null);
    expect(await pickDriveVideo(CONFIG, denied.apis)).toBeNull();
    expect(denied.seen.pickerOpened).toBe(false);
  });

  test("a blocked popup, a missing token or an unapproved scope rejects without opening the Picker", async () => {
    for (const token of [
      { error: { type: "popup_failed_to_open" } },
      { response: { error: "server_error" } },
      { response: {} },
      { response: { access_token: TOKEN }, granted: false },
    ] satisfies TokenOutcome[]) {
      const { apis, seen } = google(token, null);
      await expect(pickDriveVideo(CONFIG, apis)).rejects.toThrow();
      expect(seen.pickerOpened).toBe(false);
    }
  });

  test("a Picker result without a file ID is treated as nothing chosen", async () => {
    const { apis } = google({ response: { access_token: TOKEN } }, { action: "picked", docs: [] });
    expect(await pickDriveVideo(CONFIG, apis)).toBeNull();
  });
});
