import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  socialPlatformSchema,
  type SocialAccountSnapshot,
  type SocialPlatform,
} from "@narriflow/validators";
import { SOCIAL_PROVIDER_CAPABILITIES } from "./social-publication-config";

const CALLBACK_PATH = "/api/social/oauth/callback";
const DEFAULT_REDIRECT_PATH = "/settings/social-accounts";
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_WINDOW_MS = 60 * 1000;
const META_GRAPH_VERSION = SOCIAL_PROVIDER_CAPABILITIES.instagram_reels.apiVersion;

export class SocialOAuthError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type OAuthToken = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes: string[];
};

type ConnectedAccountInput = OAuthToken & {
  providerAccountId: string;
  displayName: string;
  handle?: string | null;
  avatarUrl?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export type PublishSocialAccount = {
  id: string;
  userId: string;
  platform: SocialPlatform;
  providerAccountId: string;
  displayName: string;
  handle: string | null;
  accessToken: string;
  scopes: string[];
  metadata: Prisma.JsonValue | null;
};

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("Database client unavailable");
  }
  return prisma;
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new SocialOAuthError("social_oauth_env_missing", `Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string) {
  return process.env[name]?.trim() || null;
}

function normalizeOrigin(origin: string) {
  return origin.replace(/\/$/, "");
}

function callbackUrl(origin: string) {
  return `${normalizeOrigin(origin)}${CALLBACK_PATH}`;
}

function base64Url(bytes: Buffer) {
  return bytes.toString("base64url");
}

function randomBase64Url(byteLength = 32) {
  return base64Url(randomBytes(byteLength));
}

function codeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function getTokenCryptoKey() {
  const raw = requireEnv("SOCIAL_TOKEN_ENCRYPTION_KEY");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(raw).digest();
}

function encryptToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getTokenCryptoKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

function decryptToken(encrypted: string) {
  const [version, ivRaw, tagRaw, ciphertextRaw] = encrypted.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) {
    throw new SocialOAuthError("social_token_invalid", "Stored social token is not in a supported format");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getTokenCryptoKey(),
    Buffer.from(ivRaw, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export async function readSocialProviderJson(response: Response) {
  const body = await response.text();
  let parsed: unknown = null;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
  }

  if (!response.ok) {
    throw new SocialOAuthError(
      "social_oauth_http_failed",
      `Social provider request failed with status ${response.status}`,
    );
  }

  return parsed;
}

type FacebookPageCandidate = { id: string; name: string | null; accessToken: string; avatarUrl: string | null; tasks: string[] };
type FacebookSelectionPayload = {
  pages: FacebookPageCandidate[];
  scopes: string[];
  expiresAt: string | null;
};

export function eligibleFacebookPages(value: unknown): FacebookPageCandidate[] {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) return [];
  return value.data.slice(0, 100).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const page = candidate as { id?: unknown; name?: unknown; access_token?: unknown; picture?: { data?: { url?: unknown } }; tasks?: unknown };
    if (typeof page.id !== "string" || page.id.length > 200 || typeof page.access_token !== "string" || page.access_token.length > 4_096 || !Array.isArray(page.tasks) || !page.tasks.includes("CREATE_CONTENT")) return [];
    return [{
      id: page.id,
      name: typeof page.name === "string" ? page.name.slice(0, 200) : null,
      accessToken: page.access_token,
      avatarUrl: typeof page.picture?.data?.url === "string" && page.picture.data.url.length <= 2_048 ? page.picture.data.url : null,
      tasks: page.tasks.filter((task): task is string => typeof task === "string").slice(0, 32),
    }];
  });
}

export function grantedFacebookScopes(value: unknown): string[] {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) return [];
  return value.data.flatMap((permission) => {
    if (!permission || typeof permission !== "object") return [];
    const item = permission as { permission?: unknown; status?: unknown };
    return typeof item.permission === "string" && item.status === "granted" ? [item.permission] : [];
  });
}

async function postForm(url: string, body: URLSearchParams, headers?: Record<string, string>) {
  return readSocialProviderJson(
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body,
    }),
  );
}

function scopesFrom(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function expiresAtFromSeconds(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(Date.now() + value * 1000)
    : null;
}

function toSnapshot(row: {
  id: string;
  platform: string;
  providerAccountId: string;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  scopes: string[];
  expiresAt: Date | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): SocialAccountSnapshot {
  return {
    id: row.id,
    platform: row.platform as SocialPlatform,
    providerAccountId: row.providerAccountId,
    displayName: row.displayName,
    handle: row.handle,
    avatarUrl: row.avatarUrl,
    scopes: row.scopes,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    status: row.status as SocialAccountSnapshot["status"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class SocialOAuthService {
  async listAccounts(userId: string, workspaceId?: string): Promise<SocialAccountSnapshot[]> {
    const prisma = requirePrisma();
    const rows = await prisma.socialAccount.findMany({
      where: {
        ...(workspaceId ? { workspaceId } : { userId }),
        status: { not: "revoked" },
      },
      orderBy: [{ platform: "asc" }, { createdAt: "desc" }],
    });
    return rows.map(toSnapshot);
  }

  async disconnectAccount(userId: string, accountId: string, workspaceId?: string) {
    const prisma = requirePrisma();
    await prisma.socialAccount.updateMany({
      where: { id: accountId, ...(workspaceId ? { workspaceId } : { userId }) },
      data: {
        status: "revoked",
        refreshTokenEncrypted: null,
        accessTokenEncrypted: encryptToken(`revoked:${randomBase64Url(16)}`),
      },
    });
  }

  async createAuthorizationUrl(params: {
    userId: string;
    workspaceId?: string;
    actorUserId?: string;
    platform: SocialPlatform;
    origin: string;
    redirectPath?: string | null;
  }) {
    const platform = socialPlatformSchema.parse(params.platform);
    const prisma = requirePrisma();
    const state = randomBase64Url(32);
    const verifier = platform === "x" || platform === "youtube_shorts"
      ? randomBase64Url(48)
      : null;
    const redirectUri = callbackUrl(params.origin);

    await prisma.socialOAuthState.create({
      data: {
        userId: params.userId,
        workspaceId: params.workspaceId ?? null,
        createdByUserId: params.actorUserId ?? params.userId,
        platform,
        state,
        codeVerifier: verifier,
        redirectPath: params.redirectPath || DEFAULT_REDIRECT_PATH,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    });

    switch (platform) {
      case "tiktok":
        return this.tiktokAuthorizationUrl(state, redirectUri);
      case "youtube_shorts":
        return this.youtubeAuthorizationUrl(state, redirectUri, verifier);
      case "instagram_reels":
      case "facebook_reels":
        return this.metaAuthorizationUrl(platform, state, redirectUri);
      case "linkedin":
        return this.linkedinAuthorizationUrl(state, redirectUri);
      case "x":
        return this.xAuthorizationUrl(state, redirectUri, verifier);
    }
  }

  async handleCallback(params: {
    state: string;
    code: string;
    origin: string;
  }): Promise<{ accounts: SocialAccountSnapshot[]; redirectPath: string; facebookSelectionToken?: string }> {
    const prisma = requirePrisma();
    const savedState = await prisma.socialOAuthState.findUnique({
      where: { state: params.state },
    });

    if (!savedState || savedState.expiresAt.getTime() < Date.now()) {
      if (savedState) {
        await prisma.socialOAuthState.delete({ where: { id: savedState.id } }).catch(() => {});
      }
      throw new SocialOAuthError("social_oauth_state_invalid", "Social OAuth state is missing or expired");
    }

    const redirectUri = callbackUrl(params.origin);
    const platform = savedState.platform as SocialPlatform;
    if (platform === "facebook_reels") {
      const facebook = await this.connectFacebook(savedState.userId, params.code, redirectUri, savedState.workspaceId);
      if (facebook.selection) {
        await prisma.socialOAuthState.update({
          where: { id: savedState.id },
          data: { codeVerifier: encryptToken(JSON.stringify(facebook.selection)), expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS) },
        });
        return { accounts: [], redirectPath: savedState.redirectPath || DEFAULT_REDIRECT_PATH, facebookSelectionToken: savedState.state };
      }
      await prisma.socialOAuthState.delete({ where: { id: savedState.id } });
      return { accounts: facebook.accounts, redirectPath: savedState.redirectPath || DEFAULT_REDIRECT_PATH };
    }
    const connected =
      platform === "tiktok"
        ? await this.connectTikTok(savedState.userId, params.code, redirectUri, savedState.workspaceId)
        : platform === "youtube_shorts"
          ? await this.connectYouTube(savedState.userId, params.code, redirectUri, savedState.codeVerifier, savedState.workspaceId)
          : platform === "instagram_reels"
            ? await this.connectInstagram(savedState.userId, params.code, redirectUri, savedState.workspaceId)
            : platform === "linkedin"
              ? await this.connectLinkedIn(savedState.userId, params.code, redirectUri, savedState.workspaceId)
              : await this.connectX(savedState.userId, params.code, redirectUri, savedState.codeVerifier, savedState.workspaceId);

    await prisma.socialOAuthState.delete({ where: { id: savedState.id } });

    return {
      accounts: connected,
      redirectPath: savedState.redirectPath || DEFAULT_REDIRECT_PATH,
    };
  }

  async getFacebookPageSelection(userId: string, workspaceId: string, token: string) {
    const state = await requirePrisma().socialOAuthState.findFirst({
      where: { state: token, userId, workspaceId, platform: "facebook_reels", expiresAt: { gt: new Date() }, codeVerifier: { not: null } },
    });
    if (!state?.codeVerifier) throw new SocialOAuthError("social_facebook_selection_invalid", "Facebook Page selection is invalid or expired");
    const payload = JSON.parse(decryptToken(state.codeVerifier)) as FacebookSelectionPayload;
    return payload.pages.map(({ id, name, avatarUrl }) => ({ id, name, avatarUrl }));
  }

  async completeFacebookPageSelection(userId: string, workspaceId: string, token: string, pageId: string) {
    const prisma = requirePrisma();
    const state = await prisma.socialOAuthState.findFirst({
      where: { state: token, userId, workspaceId, platform: "facebook_reels", expiresAt: { gt: new Date() }, codeVerifier: { not: null } },
    });
    if (!state?.codeVerifier) throw new SocialOAuthError("social_facebook_selection_invalid", "Facebook Page selection is invalid or expired");
    const payload = JSON.parse(decryptToken(state.codeVerifier)) as FacebookSelectionPayload;
    const page = payload.pages.find((candidate) => candidate.id === pageId);
    if (!page) throw new SocialOAuthError("social_facebook_page_invalid", "Selected Facebook Page is not eligible");
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.socialOAuthState.deleteMany({ where: { id: state.id, codeVerifier: state.codeVerifier } });
      if (claimed.count !== 1) throw new SocialOAuthError("social_facebook_selection_invalid", "Facebook Page selection is invalid or expired");
      return this.upsertAccount(userId, "facebook_reels", {
        providerAccountId: page.id,
        displayName: page.name || "Facebook Page",
        handle: null,
        avatarUrl: page.avatarUrl,
        accessToken: page.accessToken,
        refreshToken: null,
        scopes: payload.scopes,
        expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
        metadata: { pageId: page.id, pageName: page.name ?? null, tasks: page.tasks },
      }, workspaceId, tx);
    });
  }

  async getPublishAccount(accountId: string): Promise<PublishSocialAccount> {
    const prisma = requirePrisma();
    const row = await prisma.socialAccount.findUnique({ where: { id: accountId } });
    if (!row || row.status === "revoked") {
      throw new SocialOAuthError("social_account_missing", "Connected social account was not found");
    }

    const refreshDue =
      row.expiresAt &&
      row.expiresAt.getTime() - Date.now() <= TOKEN_REFRESH_WINDOW_MS;

    const activeRow =
      refreshDue && row.refreshTokenEncrypted
        ? await this.refreshAccount(row.id)
        : row;

    if (
      activeRow.expiresAt &&
      activeRow.expiresAt.getTime() <= Date.now() &&
      !activeRow.refreshTokenEncrypted
    ) {
      await prisma.socialAccount.update({
        where: { id: activeRow.id },
        data: { status: "expired" },
      });
      throw new SocialOAuthError("social_account_expired", "Connected social account token has expired");
    }

    return {
      id: activeRow.id,
      userId: activeRow.userId,
      platform: activeRow.platform as SocialPlatform,
      providerAccountId: activeRow.providerAccountId,
      displayName: activeRow.displayName,
      handle: activeRow.handle,
      accessToken: decryptToken(activeRow.accessTokenEncrypted),
      scopes: activeRow.scopes,
      metadata: activeRow.metadata,
    };
  }

  private async upsertAccount(
    userId: string,
    platform: SocialPlatform,
    input: ConnectedAccountInput,
    workspaceId?: string | null,
    client?: Prisma.TransactionClient,
  ) {
    const prisma = client ?? requirePrisma();
    const existing = workspaceId
      ? await prisma.socialAccount.findUnique({
          where: {
            workspaceId_platform_providerAccountId: {
              workspaceId,
              platform,
              providerAccountId: input.providerAccountId,
            },
          },
        })
      : await prisma.socialAccount.findFirst({
          where: { userId, platform, providerAccountId: input.providerAccountId },
        });

    const encryptedAccessToken = encryptToken(input.accessToken);
    const encryptedRefreshToken =
      input.refreshToken === undefined
        ? existing?.refreshTokenEncrypted ?? null
        : input.refreshToken
          ? encryptToken(input.refreshToken)
          : null;

    const data = {
      displayName: input.displayName,
      handle: input.handle ?? null,
      avatarUrl: input.avatarUrl ?? null,
      accessTokenEncrypted: encryptedAccessToken,
      refreshTokenEncrypted: encryptedRefreshToken,
      scopes: input.scopes,
      expiresAt: input.expiresAt ?? null,
      status: "active" as const,
      metadata: input.metadata ?? Prisma.JsonNull,
    };

    const row = existing
      ? await prisma.socialAccount.update({
          where: { id: existing.id },
          data,
        })
      : await prisma.socialAccount.create({
          data: {
            userId,
            workspaceId: workspaceId ?? null,
            createdByUserId: userId,
            platform,
            providerAccountId: input.providerAccountId,
            ...data,
          },
        });

    return toSnapshot(row);
  }

  private tiktokAuthorizationUrl(state: string, redirectUri: string) {
    const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
    url.searchParams.set("client_key", requireEnv("TIKTOK_CLIENT_KEY"));
    url.searchParams.set("response_type", "code");
    url.searchParams.set(
      "scope",
      SOCIAL_PROVIDER_CAPABILITIES.tiktok.requiredScopes.join(","),
    );
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  private youtubeAuthorizationUrl(state: string, redirectUri: string, verifier: string | null) {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", requireEnv("GOOGLE_CLIENT_ID"));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set(
      "scope",
      SOCIAL_PROVIDER_CAPABILITIES.youtube_shorts.requiredScopes.join(" "),
    );
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", state);
    if (verifier) {
      url.searchParams.set("code_challenge", codeChallenge(verifier));
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  }

  private metaAuthorizationUrl(platform: "instagram_reels" | "facebook_reels", state: string, redirectUri: string) {
    const url = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
    url.searchParams.set("client_id", requireEnv("META_CLIENT_ID"));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set(
      "scope",
      SOCIAL_PROVIDER_CAPABILITIES[platform].requiredScopes.join(","),
    );
    url.searchParams.set("state", state);
    return url.toString();
  }

  private linkedinAuthorizationUrl(state: string, redirectUri: string) {
    const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", requireEnv("LINKEDIN_CLIENT_ID"));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SOCIAL_PROVIDER_CAPABILITIES.linkedin.requiredScopes.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }

  private xAuthorizationUrl(state: string, redirectUri: string, verifier: string | null) {
    if (!verifier) {
      throw new SocialOAuthError("social_oauth_pkce_missing", "X OAuth requires PKCE");
    }
    const url = new URL("https://x.com/i/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", requireEnv("X_CLIENT_ID"));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SOCIAL_PROVIDER_CAPABILITIES.x.requiredScopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  private async connectTikTok(userId: string, code: string, redirectUri: string, workspaceId?: string | null) {
    const token = await postForm(
      "https://open.tiktokapis.com/v2/oauth/token/",
      new URLSearchParams({
        client_key: requireEnv("TIKTOK_CLIENT_KEY"),
        client_secret: requireEnv("TIKTOK_CLIENT_SECRET"),
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    ) as Record<string, unknown>;

    const accessToken = String(token.access_token ?? "");
    if (!accessToken) {
      throw new SocialOAuthError("social_oauth_token_missing", "TikTok did not return an access token");
    }

    const userInfo = await readSocialProviderJson(
      await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    ) as {
      data?: { user?: { open_id?: string; display_name?: string; avatar_url?: string } };
    };
    const user = userInfo.data?.user ?? {};
    const providerAccountId = String(token.open_id ?? user.open_id ?? "");
    if (!providerAccountId) {
      throw new SocialOAuthError("social_oauth_profile_missing", "TikTok profile did not include an account id");
    }

    return [
      await this.upsertAccount(userId, "tiktok", {
        providerAccountId,
        displayName: user.display_name || "TikTok account",
        handle: null,
        avatarUrl: user.avatar_url ?? null,
        accessToken,
        refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : null,
        scopes: scopesFrom(token.scope),
        expiresAt: expiresAtFromSeconds(token.expires_in),
        metadata: {
          openId: providerAccountId,
          refreshExpiresAt: expiresAtFromSeconds(token.refresh_expires_in)?.toISOString() ?? null,
        },
      }, workspaceId),
    ];
  }

  private async connectYouTube(
    userId: string,
    code: string,
    redirectUri: string,
    verifier: string | null,
    workspaceId?: string | null,
  ) {
    const body = new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    if (verifier) body.set("code_verifier", verifier);

    const token = await postForm("https://oauth2.googleapis.com/token", body) as Record<string, unknown>;
    const accessToken = String(token.access_token ?? "");
    if (!accessToken) {
      throw new SocialOAuthError("social_oauth_token_missing", "Google did not return an access token");
    }

    const channelResponse = await readSocialProviderJson(
      await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    ) as {
      items?: Array<{
        id?: string;
        snippet?: {
          title?: string;
          customUrl?: string;
          thumbnails?: { default?: { url?: string } };
        };
      }>;
    };
    const channel = channelResponse.items?.[0];
    if (!channel?.id) {
      throw new SocialOAuthError("social_oauth_profile_missing", "YouTube did not return a channel for this account");
    }

    return [
      await this.upsertAccount(userId, "youtube_shorts", {
        providerAccountId: channel.id,
        displayName: channel.snippet?.title || "YouTube channel",
        handle: channel.snippet?.customUrl ?? null,
        avatarUrl: channel.snippet?.thumbnails?.default?.url ?? null,
        accessToken,
        refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : undefined,
        scopes: scopesFrom(token.scope),
        expiresAt: expiresAtFromSeconds(token.expires_in),
        metadata: { channelId: channel.id },
      }, workspaceId),
    ];
  }

  private async connectInstagram(userId: string, code: string, redirectUri: string, workspaceId?: string | null) {
    const shortToken = await readSocialProviderJson(
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token?` +
          new URLSearchParams({
            client_id: requireEnv("META_CLIENT_ID"),
            client_secret: requireEnv("META_CLIENT_SECRET"),
            code,
            redirect_uri: redirectUri,
          }),
      ),
    ) as Record<string, unknown>;

    const shortAccessToken = String(shortToken.access_token ?? "");
    if (!shortAccessToken) {
      throw new SocialOAuthError("social_oauth_token_missing", "Meta did not return an access token");
    }

    const longToken = await readSocialProviderJson(
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token?` +
          new URLSearchParams({
            grant_type: "fb_exchange_token",
            client_id: requireEnv("META_CLIENT_ID"),
            client_secret: requireEnv("META_CLIENT_SECRET"),
            fb_exchange_token: shortAccessToken,
          }),
      ),
    ).catch(() => shortToken) as Record<string, unknown>;

    const userAccessToken = String(longToken.access_token ?? shortAccessToken);
    const pages = await readSocialProviderJson(
      await fetch(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/me/accounts?` +
          new URLSearchParams({
            fields: "id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}",
            access_token: userAccessToken,
          }),
      ),
    ) as {
      data?: Array<{
        id?: string;
        name?: string;
        access_token?: string;
        instagram_business_account?: {
          id?: string;
          username?: string;
          name?: string;
          profile_picture_url?: string;
        };
      }>;
    };

    const connected: SocialAccountSnapshot[] = [];
    for (const page of pages.data ?? []) {
      const ig = page.instagram_business_account;
      if (!ig?.id || !page.access_token) continue;
      connected.push(
        await this.upsertAccount(userId, "instagram_reels", {
          providerAccountId: ig.id,
          displayName: ig.name || ig.username || page.name || "Instagram account",
          handle: ig.username ? `@${ig.username}` : null,
          avatarUrl: ig.profile_picture_url ?? null,
          accessToken: page.access_token,
          refreshToken: null,
          scopes: scopesFrom(shortToken.scope),
          expiresAt: expiresAtFromSeconds(longToken.expires_in),
          metadata: {
            pageId: page.id ?? null,
            pageName: page.name ?? null,
            igUserId: ig.id,
          },
        }, workspaceId),
      );
    }

    if (connected.length === 0) {
      throw new SocialOAuthError(
        "social_instagram_business_missing",
        "No Instagram Business or Creator account connected to a Facebook Page was returned",
      );
    }
    return connected;
  }

  private async connectFacebook(userId: string, code: string, redirectUri: string, workspaceId?: string | null): Promise<{ accounts: SocialAccountSnapshot[]; selection: FacebookSelectionPayload | null }> {
    const shortToken = await readSocialProviderJson(await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token?${new URLSearchParams({
        client_id: requireEnv("META_CLIENT_ID"),
        client_secret: requireEnv("META_CLIENT_SECRET"),
        code,
        redirect_uri: redirectUri,
      })}`,
    )) as Record<string, unknown>;
    const shortAccessToken = String(shortToken.access_token ?? "");
    if (!shortAccessToken) {
      throw new SocialOAuthError("social_oauth_token_missing", "Meta did not return an access token");
    }
    const longToken = await readSocialProviderJson(await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token?${new URLSearchParams({
        grant_type: "fb_exchange_token",
        client_id: requireEnv("META_CLIENT_ID"),
        client_secret: requireEnv("META_CLIENT_SECRET"),
        fb_exchange_token: shortAccessToken,
      })}`,
    )) as Record<string, unknown>;
    const userAccessToken = String(longToken.access_token ?? "");
    if (!userAccessToken) {
      throw new SocialOAuthError("social_oauth_token_missing", "Meta did not return a long-lived access token");
    }
    const permissions = await readSocialProviderJson(await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/me/permissions?${new URLSearchParams({ access_token: userAccessToken })}`,
    )) as { data?: Array<{ permission?: unknown; status?: unknown }> };
    const grantedScopes = grantedFacebookScopes(permissions);
    const missingScopes = SOCIAL_PROVIDER_CAPABILITIES.facebook_reels.requiredScopes.filter((scope) => !grantedScopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new SocialOAuthError("social_facebook_permissions_missing", "Facebook did not grant every required Page publishing permission");
    }
    const pages = await readSocialProviderJson(await fetch(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/me/accounts?${new URLSearchParams({
        fields: "id,name,access_token,picture{url},tasks",
        access_token: userAccessToken,
      })}`,
    ));
    const eligiblePages = eligibleFacebookPages(pages);
    if (eligiblePages.length === 0) {
      throw new SocialOAuthError("social_facebook_page_missing", "No Facebook Page with content publishing access was returned");
    }
    const expiresAt = expiresAtFromSeconds(longToken.expires_in);
    if (eligiblePages.length > 1) {
      return { accounts: [], selection: { pages: eligiblePages, scopes: grantedScopes, expiresAt: expiresAt?.toISOString() ?? null } };
    }
    const page = eligiblePages[0]!;
    const account = await this.upsertAccount(userId, "facebook_reels", {
        providerAccountId: page.id,
        displayName: page.name || "Facebook Page",
        handle: null,
        avatarUrl: page.avatarUrl,
        accessToken: page.accessToken,
        refreshToken: null,
        scopes: grantedScopes,
        expiresAt,
        metadata: { pageId: page.id, pageName: page.name ?? null, tasks: page.tasks },
      }, workspaceId);
    return { accounts: [account], selection: null };
  }

  private async connectLinkedIn(userId: string, code: string, redirectUri: string, workspaceId?: string | null) {
    const token = await postForm(
      "https://www.linkedin.com/oauth/v2/accessToken",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: requireEnv("LINKEDIN_CLIENT_ID"),
        client_secret: requireEnv("LINKEDIN_CLIENT_SECRET"),
      }),
    ) as Record<string, unknown>;
    const accessToken = String(token.access_token ?? "");
    if (!accessToken) {
      throw new SocialOAuthError("social_oauth_token_missing", "LinkedIn did not return an access token");
    }

    const profile = await readSocialProviderJson(
      await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    ) as {
      sub?: string;
      name?: string;
      given_name?: string;
      family_name?: string;
      picture?: string;
    };
    if (!profile.sub) {
      throw new SocialOAuthError("social_oauth_profile_missing", "LinkedIn profile did not include a subject id");
    }

    return [
      await this.upsertAccount(userId, "linkedin", {
        providerAccountId: profile.sub,
        displayName:
          profile.name ||
          [profile.given_name, profile.family_name].filter(Boolean).join(" ") ||
          "LinkedIn member",
        handle: null,
        avatarUrl: profile.picture ?? null,
        accessToken,
        refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : undefined,
        scopes: scopesFrom(token.scope),
        expiresAt: expiresAtFromSeconds(token.expires_in),
        metadata: { ownerUrn: `urn:li:person:${profile.sub}` },
      }, workspaceId),
    ];
  }

  private async connectX(
    userId: string,
    code: string,
    redirectUri: string,
    verifier: string | null,
    workspaceId?: string | null,
  ) {
    if (!verifier) {
      throw new SocialOAuthError("social_oauth_pkce_missing", "X OAuth state did not include a verifier");
    }

    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: requireEnv("X_CLIENT_ID"),
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const clientSecret = optionalEnv("X_CLIENT_SECRET");
    const headers = clientSecret
      ? {
          Authorization: `Basic ${Buffer.from(`${requireEnv("X_CLIENT_ID")}:${clientSecret}`).toString("base64")}`,
        }
      : undefined;

    const token = await postForm("https://api.x.com/2/oauth2/token", body, headers) as Record<string, unknown>;
    const accessToken = String(token.access_token ?? "");
    if (!accessToken) {
      throw new SocialOAuthError("social_oauth_token_missing", "X did not return an access token");
    }

    const profile = await readSocialProviderJson(
      await fetch("https://api.x.com/2/users/me?user.fields=profile_image_url", {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    ) as {
      data?: { id?: string; name?: string; username?: string; profile_image_url?: string };
    };
    const user = profile.data;
    if (!user?.id) {
      throw new SocialOAuthError("social_oauth_profile_missing", "X profile did not include a user id");
    }

    return [
      await this.upsertAccount(userId, "x", {
        providerAccountId: user.id,
        displayName: user.name || user.username || "X account",
        handle: user.username ? `@${user.username}` : null,
        avatarUrl: user.profile_image_url ?? null,
        accessToken,
        refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : undefined,
        scopes: scopesFrom(token.scope),
        expiresAt: expiresAtFromSeconds(token.expires_in),
        metadata: { userId: user.id, username: user.username ?? null },
      }, workspaceId),
    ];
  }

  private async refreshAccount(accountId: string) {
    const prisma = requirePrisma();
    const row = await prisma.socialAccount.findUnique({ where: { id: accountId } });
    if (!row?.refreshTokenEncrypted) {
      throw new SocialOAuthError("social_account_refresh_missing", "Connected social account has no refresh token");
    }

    const refreshToken = decryptToken(row.refreshTokenEncrypted);
    const refreshed =
      row.platform === "tiktok"
        ? await this.refreshTikTok(refreshToken)
        : row.platform === "youtube_shorts"
          ? await this.refreshGoogle(refreshToken)
          : row.platform === "linkedin"
            ? await this.refreshLinkedIn(refreshToken)
            : row.platform === "x"
              ? await this.refreshX(refreshToken)
              : null;

    if (!refreshed) return row;

    return prisma.socialAccount.update({
      where: { id: row.id },
      data: {
        accessTokenEncrypted: encryptToken(refreshed.accessToken),
        refreshTokenEncrypted:
          refreshed.refreshToken === undefined
            ? row.refreshTokenEncrypted
            : refreshed.refreshToken
              ? encryptToken(refreshed.refreshToken)
              : null,
        expiresAt: refreshed.expiresAt ?? null,
        scopes: refreshed.scopes.length > 0 ? refreshed.scopes : row.scopes,
        status: "active",
      },
    });
  }

  private async refreshTikTok(refreshToken: string): Promise<OAuthToken> {
    const token = await postForm(
      "https://open.tiktokapis.com/v2/oauth/token/",
      new URLSearchParams({
        client_key: requireEnv("TIKTOK_CLIENT_KEY"),
        client_secret: requireEnv("TIKTOK_CLIENT_SECRET"),
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    ) as Record<string, unknown>;
    return {
      accessToken: String(token.access_token ?? ""),
      refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : undefined,
      expiresAt: expiresAtFromSeconds(token.expires_in),
      scopes: scopesFrom(token.scope),
    };
  }

  private async refreshGoogle(refreshToken: string): Promise<OAuthToken> {
    const token = await postForm(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        client_id: requireEnv("GOOGLE_CLIENT_ID"),
        client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    ) as Record<string, unknown>;
    return {
      accessToken: String(token.access_token ?? ""),
      refreshToken: undefined,
      expiresAt: expiresAtFromSeconds(token.expires_in),
      scopes: scopesFrom(token.scope),
    };
  }

  private async refreshLinkedIn(refreshToken: string): Promise<OAuthToken> {
    const token = await postForm(
      "https://www.linkedin.com/oauth/v2/accessToken",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: requireEnv("LINKEDIN_CLIENT_ID"),
        client_secret: requireEnv("LINKEDIN_CLIENT_SECRET"),
      }),
    ) as Record<string, unknown>;
    return {
      accessToken: String(token.access_token ?? ""),
      refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : undefined,
      expiresAt: expiresAtFromSeconds(token.expires_in),
      scopes: scopesFrom(token.scope),
    };
  }

  private async refreshX(refreshToken: string): Promise<OAuthToken> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: requireEnv("X_CLIENT_ID"),
    });
    const clientSecret = optionalEnv("X_CLIENT_SECRET");
    const headers = clientSecret
      ? {
          Authorization: `Basic ${Buffer.from(`${requireEnv("X_CLIENT_ID")}:${clientSecret}`).toString("base64")}`,
        }
      : undefined;
    const token = await postForm("https://api.x.com/2/oauth2/token", body, headers) as Record<string, unknown>;
    return {
      accessToken: String(token.access_token ?? ""),
      refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : undefined,
      expiresAt: expiresAtFromSeconds(token.expires_in),
      scopes: scopesFrom(token.scope),
    };
  }
}

export const socialOAuthService = new SocialOAuthService();
