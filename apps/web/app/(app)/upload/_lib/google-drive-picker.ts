import { GOOGLE_DRIVE_FILE_SCOPE } from "@narriflow/validators";
import { loadScript } from "./source-pickers";

const IDENTITY_SCRIPT = "https://accounts.google.com/gsi/client";
const GAPI_SCRIPT = "https://apis.google.com/js/api.js";

interface TokenResponse {
  access_token?: string;
  error?: string;
}

interface PickerDocument {
  [field: string]: unknown;
}

interface PickerBuilder {
  addView(view: unknown): PickerBuilder;
  enableFeature(feature: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setCallback(callback: (data: Record<string, unknown>) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}

/** The slice of Google Identity Services and the Picker API used here. */
export interface GoogleApis {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback(response: TokenResponse): void;
        error_callback(error: { type?: string }): void;
      }): { requestAccessToken(): void };
      hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean;
    };
  };
  picker: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId: string) => unknown;
    ViewId: { DOCS_VIDEOS: string };
    Feature: { SUPPORT_DRIVES: string };
    Action: { PICKED: string; CANCEL: string };
    Response: { ACTION: string; DOCUMENTS: string };
    Document: { ID: string; NAME: string };
  };
}

export interface DriveConfig {
  apiKey: string;
  clientId: string;
  appId: string;
}

/** The chosen file and the short-lived token that can read only that file. */
export interface DrivePick {
  fileId: string;
  name: string;
  accessToken: string;
}

interface GoogleWindow {
  google?: { accounts?: GoogleApis["accounts"]; picker?: GoogleApis["picker"] };
  gapi?: { load(api: string, callback: () => void): void };
}

export async function loadGoogleApis(): Promise<GoogleApis> {
  await Promise.all([loadScript(IDENTITY_SCRIPT), loadScript(GAPI_SCRIPT)]);
  const scope = window as unknown as GoogleWindow;
  const gapi = scope.gapi;
  if (!gapi || !scope.google?.accounts) throw new Error("Google did not load");
  await new Promise<void>((resolve) => gapi.load("picker", () => resolve()));
  const picker = (window as unknown as GoogleWindow).google?.picker;
  if (!picker) throw new Error("Google Picker did not load");
  return { accounts: scope.google.accounts, picker };
}

function requestDriveToken(
  google: GoogleApis,
  clientId: string,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_DRIVE_FILE_SCOPE,
      callback: (response) => {
        if (response.error === "access_denied") {
          resolve(null);
        } else if (
          response.access_token &&
          !response.error &&
          google.accounts.oauth2.hasGrantedAllScopes(response, GOOGLE_DRIVE_FILE_SCOPE)
        ) {
          resolve(response.access_token);
        } else {
          reject(new Error("Google Drive access was not granted"));
        }
      },
      error_callback: (error) => {
        if (error.type === "popup_closed") resolve(null);
        else reject(new Error("Google sign-in could not open"));
      },
    });
    client.requestAccessToken();
  });
}

function showPicker(
  google: GoogleApis,
  config: DriveConfig,
  accessToken: string,
): Promise<DrivePick | null> {
  const { picker } = google;
  return new Promise((resolve) => {
    new picker.PickerBuilder()
      .addView(new picker.DocsView(picker.ViewId.DOCS_VIDEOS))
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setOAuthToken(accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setCallback((data) => {
        const action = data[picker.Response.ACTION];
        if (action === picker.Action.PICKED) {
          const documents = data[picker.Response.DOCUMENTS] as
            | PickerDocument[]
            | undefined;
          const id = documents?.[0]?.[picker.Document.ID];
          const name = documents?.[0]?.[picker.Document.NAME];
          resolve(
            typeof id === "string"
              ? { fileId: id, name: typeof name === "string" ? name : "", accessToken }
              : null,
          );
        } else if (action === picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build()
      .setVisible(true);
  });
}

/** Asks for `drive.file` access, then lets the person pick one video from Drive.
 *  Resolves null when they close either window. Call it straight from the
 *  click with the libraries already loaded: the sign-in popup opens before
 *  the first `await`, while the click still counts as the person's own action. */
export function pickDriveVideo(
  config: DriveConfig,
  google: GoogleApis,
): Promise<DrivePick | null> {
  return requestDriveToken(google, config.clientId).then((accessToken) =>
    accessToken ? showPicker(google, config, accessToken) : null,
  );
}
