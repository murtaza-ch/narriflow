import { bindServiceTestEnvironment } from "./runtime-test-support";
import { describe, expect, test } from "bun:test";
import { MAX_UPLOAD_SIZE_BYTES } from "@narriflow/validators";
import {
  createDriveTokenCipher,
  createGoogleDriveFileReader,
  DriveSourceError,
  driveDownloadRefusal,
  driveFileMediaUrl,
  readDriveFileMetadata,
  verifyDriveAccessToken,
} from "./drive-source";

const TOKEN = "ya29.a0-super-secret-access-token";
const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123";

function drive(respond: (url: URL, headers: Headers) => Response | Promise<Response>) {
  const seen: Array<{ url: URL; headers: Headers; init: RequestInit }> = [];
  const request = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url=new URL(String(input)), headers=new Headers(init.headers);
    seen.push({url,headers,init});
    return respond(url,headers);
  }) as typeof globalThis.fetch;
  return { seen, options: { fetch: request } };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const video = {
  id: FILE_ID,
  name: "Weekly sync.mp4",
  mimeType: "video/mp4",
  size: "73400320",
  videoMediaMetadata: { durationMillis: "3600500" },
};

async function failure(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("readDriveFileMetadata", () => {
  test("asks Drive for the chosen file with the bearer token and returns what intake admits on", bindServiceTestEnvironment(async () => {
    const { seen, options } = drive(() => json(video));
    const metadata = await readDriveFileMetadata({ fileId: FILE_ID, accessToken: TOKEN }, options);
    expect(metadata).toEqual({
      fileId: FILE_ID,
      name: "Weekly sync.mp4",
      mimeType: "video/mp4",
      sizeBytes: 73_400_320,
      durationSeconds: 3601,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.origin + seen[0]!.url.pathname).toBe(`https://www.googleapis.com/drive/v3/files/${FILE_ID}`);
    expect(seen[0]!.url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(seen[0]!.url.searchParams.get("fields")).toContain("videoMediaMetadata");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.init.redirect).toBe("error");
  }));

  test("a video whose duration Drive hasn't measured yet is admitted without one", bindServiceTestEnvironment(async () => {
    const { options } = drive(() => json({ ...video, videoMediaMetadata: undefined }));
    expect((await readDriveFileMetadata({ fileId: FILE_ID, accessToken: TOKEN }, options)).durationSeconds).toBeNull();
  }));

  test("an expired token is its own failure, other refusals mean the file can't be read", bindServiceTestEnvironment(async () => {
    for (const [status, code] of [
      [401, "drive_token_expired"],
      [403, "drive_file_unavailable"],
      [404, "drive_file_unavailable"],
      [500, "drive_file_unavailable"],
    ] as const) {
      const { options } = drive(() => json({ error: { message: `leak ${TOKEN}` } }, status));
      const error = await failure(() => readDriveFileMetadata({ fileId: FILE_ID, accessToken: TOKEN }, options));
      expect(error).toBeInstanceOf(DriveSourceError);
      expect((error as DriveSourceError).code).toBe(code);
    }
  }));

  test("files that are not downloadable videos are refused with plain codes", bindServiceTestEnvironment(async () => {
    const cases: Array<[unknown, string]> = [
      [{ ...video, mimeType: "application/vnd.google-apps.folder" }, "drive_file_not_video"],
      [{ ...video, mimeType: "audio/mpeg" }, "drive_file_not_video"],
      [{ ...video, trashed: true }, "drive_file_unavailable"],
      [{ ...video, capabilities: { canDownload: false } }, "drive_file_unavailable"],
      [{ ...video, size: String(MAX_UPLOAD_SIZE_BYTES + 1) }, "remote_media_too_large"],
      [{ name: "no id" }, "drive_file_unavailable"],
    ];
    for (const [body, code] of cases) {
      const { options } = drive(() => json(body));
      const error = await failure(() => readDriveFileMetadata({ fileId: FILE_ID, accessToken: TOKEN }, options));
      expect((error as DriveSourceError).code).toBe(code);
    }
  }));

  test("network failures and unreadable bodies never expose the token", bindServiceTestEnvironment(async () => {
    const network = drive(() => {
      throw new Error(`socket closed while sending Bearer ${TOKEN}`);
    });
    const garbage = drive(() => new Response("<html>not json</html>", { status: 200 }));
    for (const { options } of [network, garbage]) {
      const error = await failure(() => readDriveFileMetadata({ fileId: FILE_ID, accessToken: TOKEN }, options));
      expect((error as DriveSourceError).code).toBe("drive_file_unavailable");
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as Error).stack ?? "").not.toContain(TOKEN);
    }
  }));
});

const CLIENT_ID = "123-narriflow.apps.googleusercontent.com";
const tokenInfo = (overrides: Record<string, unknown> = {}) =>
  json({
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    scope: "https://www.googleapis.com/auth/drive.file",
    expires_in: "3000",
    ...overrides,
  });

describe("verifyDriveAccessToken", () => {
  test("accepts a token issued to this app's client with drive.file, sending it in a POST body", bindServiceTestEnvironment(async () => {
    const { seen, options } = drive(() => tokenInfo());
    await verifyDriveAccessToken(TOKEN, { clientId: CLIENT_ID }, options);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.href).toBe("https://oauth2.googleapis.com/tokeninfo");
    expect(seen[0]!.url.href).not.toContain(TOKEN);
    expect(seen[0]!.init.redirect).toBe("error");
    expect(seen[0]!.init.method).toBe("POST");
    expect(new URLSearchParams(String(seen[0]!.init.body)).get("access_token")).toBe(TOKEN);
    expect(seen[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  }));

  test("refuses a token minted for another client or without drive.file, with a fixed message", bindServiceTestEnvironment(async () => {
    for (const info of [
      { aud: "someone-else.apps.googleusercontent.com" },
      { aud: undefined },
      { scope: "https://www.googleapis.com/auth/drive.readonly" },
      { scope: "openid email" },
      { scope: undefined },
    ]) {
      const { options } = drive(() => tokenInfo(info));
      const error = await failure(() => verifyDriveAccessToken(TOKEN, { clientId: CLIENT_ID }, options));
      expect((error as DriveSourceError).code).toBe("drive_token_invalid");
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
  }));

  test("a token Google doesn't recognize is expired; an outage is not blamed on the token", bindServiceTestEnvironment(async () => {
    const cases: Array<[() => Response, string]> = [
      [() => json({ error: "invalid_token", error_description: `Invalid ${TOKEN}` }, 400), "drive_token_expired"],
      [() => json({}, 500), "drive_file_unavailable"],
      [() => new Response("<html>", { status: 200 }), "drive_file_unavailable"],
    ];
    for (const [respond, code] of cases) {
      const { options } = drive(respond);
      const error = await failure(() => verifyDriveAccessToken(TOKEN, { clientId: CLIENT_ID }, options));
      expect((error as DriveSourceError).code).toBe(code);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
    const network = drive(() => {
      throw new Error(`reset while posting ${TOKEN}`);
    });
    const error = await failure(() => verifyDriveAccessToken(TOKEN, { clientId: CLIENT_ID }, network.options));
    expect((error as DriveSourceError).code).toBe("drive_file_unavailable");
    expect((error as Error).message).not.toContain(TOKEN);
  }));
});

describe("createGoogleDriveFileReader", () => {
  const files = (url: URL) => (url.hostname === "oauth2.googleapis.com" ? tokenInfo() : json(video));

  test("verifies the token before reading the file", bindServiceTestEnvironment(async () => {
    const { seen, options } = drive((url) => files(url));
    const metadata = await createGoogleDriveFileReader({ clientId: CLIENT_ID, ...options }).read({
      fileId: FILE_ID,
      accessToken: TOKEN,
    });
    expect(metadata.fileId).toBe(FILE_ID);
    expect(seen.map((request) => request.url.hostname)).toEqual(["oauth2.googleapis.com", "www.googleapis.com"]);
  }));

  test("a foreign token never reaches the Drive API", bindServiceTestEnvironment(async () => {
    const { seen, options } = drive((url) =>
      url.hostname === "oauth2.googleapis.com" ? tokenInfo({ aud: "other" }) : json(video),
    );
    const error = await failure(() =>
      createGoogleDriveFileReader({ clientId: CLIENT_ID, ...options }).read({ fileId: FILE_ID, accessToken: TOKEN }),
    );
    expect((error as DriveSourceError).code).toBe("drive_token_invalid");
    expect(seen.map((request) => request.url.hostname)).toEqual(["oauth2.googleapis.com"]);
  }));

  test("without a configured client ID nothing is admitted and nothing is fetched", bindServiceTestEnvironment(async () => {
    const prior = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    try {
      const { seen, options } = drive((url) => files(url));
      const error = await failure(() =>
        createGoogleDriveFileReader(options).read({ fileId: FILE_ID, accessToken: TOKEN }),
      );
      expect((error as DriveSourceError).code).toBe("drive_token_invalid");
      expect(seen).toHaveLength(0);
    } finally {
      if (prior !== undefined) process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = prior;
    }
  }));
});

describe("driveDownloadRefusal", () => {
  const reason = (value: string) => JSON.stringify({ error: { code: 403, errors: [{ reason: value }] } });

  test("an expired token is final", bindServiceTestEnvironment(() => {
    expect((driveDownloadRefusal(401, "{}") as DriveSourceError).code).toBe("drive_token_expired");
  }));

  test("a 403 rate limit is transient, other 403s and 404s are final", bindServiceTestEnvironment(() => {
    expect(driveDownloadRefusal(403, reason("userRateLimitExceeded"))).toBe("transient");
    expect(driveDownloadRefusal(403, reason("rateLimitExceeded"))).toBe("transient");
    for (const body of [
      reason("downloadQuotaExceeded"),
      reason("cannotDownloadAbusiveFile"),
      reason("forbidden"),
      "not json",
      "",
    ]) {
      expect((driveDownloadRefusal(403, body) as DriveSourceError).code).toBe("drive_file_unavailable");
    }
    expect((driveDownloadRefusal(404, "{}") as DriveSourceError).code).toBe("drive_file_unavailable");
    // A rate-limit reason only counts on a 403.
    expect((driveDownloadRefusal(404, reason("rateLimitExceeded")) as DriveSourceError).code).toBe(
      "drive_file_unavailable",
    );
  }));
});

describe("Drive references", () => {
  test("the download URL is the Drive API media endpoint", bindServiceTestEnvironment(() => {
    expect(driveFileMediaUrl(FILE_ID)).toBe(
      `https://www.googleapis.com/drive/v3/files/${FILE_ID}?alt=media&supportsAllDrives=true`,
    );
  }));
});

describe("createDriveTokenCipher", () => {
  const material = "test-data-encryption-key-material";

  test("seals a token that doesn't contain it and opens it again", bindServiceTestEnvironment(() => {
    const cipher = createDriveTokenCipher(material);
    const sealed = cipher.seal(TOKEN);
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toBe(cipher.seal(TOKEN));
    expect(cipher.open(sealed)).toBe(TOKEN);
  }));

  test("another key, a tampered value, or no key can't open it", bindServiceTestEnvironment(() => {
    const sealed = createDriveTokenCipher(material).seal(TOKEN);
    expect(() => createDriveTokenCipher("different-key-material").open(sealed)).toThrow();
    const [version, iv, tag, ciphertext] = sealed.split(":");
    const flipped = `${ciphertext!.startsWith("A") ? "B" : "A"}${ciphertext!.slice(1)}`;
    expect(() => createDriveTokenCipher(material).open([version, iv, tag, flipped].join(":"))).toThrow();
    expect(() => createDriveTokenCipher(material).open("v2:a:b:c")).toThrow();
    expect(() => createDriveTokenCipher("  ")).toThrow("SOCIAL_TOKEN_ENCRYPTION_KEY");
  }));
});

describe("Worker Drive provider boundary",()=>{
 test("metadata and token verification refuse provider redirects without following them",bindServiceTestEnvironment(async()=>{
  const metadata=drive(()=>new Response(null,{status:302,headers:{location:"http://127.0.0.1/private"}}));
  await expect(readDriveFileMetadata({fileId:FILE_ID,accessToken:TOKEN},metadata.options)).rejects.toMatchObject({code:"drive_file_unavailable"});
  expect(metadata.seen).toHaveLength(1);expect(metadata.seen[0]!.init.redirect).toBe("error");
  const token=drive(()=>new Response(null,{status:307,headers:{location:"https://other.example/collect"}}));
  await expect(verifyDriveAccessToken(TOKEN,{clientId:CLIENT_ID},token.options)).rejects.toMatchObject({code:"drive_file_unavailable"});
  expect(token.seen).toHaveLength(1);expect(token.seen[0]!.url.origin).toBe("https://oauth2.googleapis.com");
 }));
 test("a file identifier cannot change the fixed provider API path",bindServiceTestEnvironment(async()=>{
  const f=drive(()=>json(video));
  for(const fileId of ["../../tokeninfo","abc?alt=media","https://private.example/secret"]){
   await expect(readDriveFileMetadata({fileId,accessToken:TOKEN},f.options)).rejects.toMatchObject({code:"drive_file_unavailable"});
  }
  expect(f.seen).toHaveLength(0);
 }));
 test("provider JSON remains bounded and failures contain no token",bindServiceTestEnvironment(async()=>{
  let cancelled=false;
  const f=drive(()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}})));
  const error=await failure(()=>readDriveFileMetadata({fileId:FILE_ID,accessToken:TOKEN},f.options));
  expect(error).toMatchObject({code:"drive_file_unavailable"});expect(cancelled).toBe(true);expect(JSON.stringify(error)).not.toContain(TOKEN);
 }));
});
