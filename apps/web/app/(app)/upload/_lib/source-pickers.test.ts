import { describe, expect, test } from "bun:test";
import { sourcePickerConfig } from "./source-pickers";

describe("sourcePickerConfig", () => {
  test("shows no picker without configuration", () => {
    expect(sourcePickerConfig({})).toEqual({ drive: null, dropboxAppKey: null });
    expect(
      sourcePickerConfig({ NEXT_PUBLIC_GOOGLE_API_KEY: " ", NEXT_PUBLIC_DROPBOX_APP_KEY: "" }),
    ).toEqual({ drive: null, dropboxAppKey: null });
  });

  test("Drive needs the API key, the client ID and the app ID together", () => {
    const full = {
      NEXT_PUBLIC_GOOGLE_API_KEY: "key",
      NEXT_PUBLIC_GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
      NEXT_PUBLIC_GOOGLE_APP_ID: "1234567890",
    };
    expect(sourcePickerConfig(full).drive).toEqual({
      apiKey: "key",
      clientId: "client.apps.googleusercontent.com",
      appId: "1234567890",
    });
    for (const missing of Object.keys(full)) {
      expect(sourcePickerConfig({ ...full, [missing]: undefined }).drive).toBeNull();
    }
  });

  test("Dropbox needs only its app key and is independent of Drive", () => {
    expect(sourcePickerConfig({ NEXT_PUBLIC_DROPBOX_APP_KEY: " abc " })).toEqual({
      drive: null,
      dropboxAppKey: "abc",
    });
  });
});
