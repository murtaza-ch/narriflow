import { parseStaffAllowlist, type StaffAllowlist } from "@narriflow/auth";
import { parseOrigin, parseOriginList } from "@narriflow/validators/api/origins";

export type ApiEnvironment = Record<string, string | undefined>;

export interface ApiConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  /** A: where providers, machine clients and MCP resolve this API. */
  apiOrigin: string;
  /** W: where humans are sent. Never derived from `Host`. */
  webOrigin: string;
  /** Exact browser origins that may call first-party routes. */
  corsAllowedOrigins: readonly string[];
  clerk: {
    secretKey: string;
    publishableKey: string;
    /** Full frontend origins accepted in the session token's `azp`. */
    authorizedParties: readonly string[];
  };
  /** Exact Clerk user IDs of platform staff. Server-only; empty by default. */
  staffAllowlist: StaffAllowlist;
  streams: { maxConnections: number; maxConnectionsPerActor: number };
  /** The one header the ingress overwrites with the client address, or null. */
  trustedClientIpHeader: string | null;
}

/** Names the invalid settings. Values are never included, so the message is safe to log. */
export class ApiConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid API configuration: ${problems.join("; ")}`);
    this.name = "ApiConfigError";
    this.problems = problems;
  }
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

function positiveInteger(
  env: ApiEnvironment,
  name: string,
  fallback: number,
  problems: string[],
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    problems.push(`${name} must be a positive integer`);
    return fallback;
  }
  return value;
}

function required(env: ApiEnvironment, name: string, problems: string[]): string {
  const value = env[name]?.trim();
  if (!value) problems.push(`${name} is required`);
  return value ?? "";
}

function origin(env: ApiEnvironment, name: string, problems: string[]): string {
  const value = required(env, name, problems);
  if (!value) return "";
  const parsed = parseOrigin(value);
  if (!parsed) problems.push(`${name} must be a full origin without a path`);
  return parsed ?? "";
}

function originList(env: ApiEnvironment, name: string, problems: string[]) {
  try {
    return parseOriginList(env[name], name);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : `${name} is invalid`);
    return [];
  }
}

function isLoopback(value: string): boolean {
  try {
    const { hostname } = new URL(value);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Validates the core and Clerk setting groups the HTTP layer depends on.
 * Optional provider capabilities (Stripe, social, AI, ...) are validated by the
 * domains that use them so one missing optional provider never stops startup.
 */
export function loadApiConfig(env: ApiEnvironment = process.env): ApiConfig {
  const problems: string[] = [];
  const nodeEnv =
    env.NODE_ENV === "production" || env.NODE_ENV === "test"
      ? env.NODE_ENV
      : "development";

  const apiOrigin = origin(env, "API_ORIGIN", problems);
  const webOrigin = origin(env, "WEB_ORIGIN", problems);
  const corsList = originList(env, "CORS_ALLOWED_ORIGINS", problems);
  const corsAllowedOrigins = corsList.length > 0 ? corsList : webOrigin ? [webOrigin] : [];
  const authorizedParties = originList(env, "CLERK_AUTHORIZED_PARTIES", problems);
  if (authorizedParties.length === 0) {
    problems.push("CLERK_AUTHORIZED_PARTIES must list at least one frontend origin");
  }
  // The API's own origin is never a browser caller or a session audience.
  if (apiOrigin && corsAllowedOrigins.includes(apiOrigin)) {
    problems.push("CORS_ALLOWED_ORIGINS must not include API_ORIGIN");
  }
  if (apiOrigin && authorizedParties.includes(apiOrigin)) {
    problems.push("CLERK_AUTHORIZED_PARTIES must not include API_ORIGIN");
  }
  if (nodeEnv === "production") {
    for (const [name, value] of [
      ["API_ORIGIN", apiOrigin],
      ["WEB_ORIGIN", webOrigin],
    ] as const) {
      if (value && !value.startsWith("https://") && !isLoopback(value)) {
        problems.push(`${name} must use https in production`);
      }
    }
    if (corsAllowedOrigins.some((entry) => entry.includes("*"))) {
      problems.push("CORS_ALLOWED_ORIGINS must not contain wildcards");
    }
  }

  const trustedClientIpHeader = env.TRUSTED_CLIENT_IP_HEADER?.trim() || null;
  if (trustedClientIpHeader && !HEADER_NAME.test(trustedClientIpHeader)) {
    problems.push("TRUSTED_CLIENT_IP_HEADER must be a header name");
  }

  const config: ApiConfig = {
    nodeEnv,
    port: positiveInteger(env, "PORT", 4000, problems),
    apiOrigin,
    webOrigin,
    corsAllowedOrigins,
    clerk: {
      secretKey: required(env, "CLERK_SECRET_KEY", problems),
      publishableKey: required(env, "CLERK_PUBLISHABLE_KEY", problems),
      authorizedParties,
    },
    staffAllowlist: parseStaffAllowlist(env.PLATFORM_STAFF_CLERK_USER_IDS),
    streams: {
      maxConnections: positiveInteger(env, "API_STREAM_MAX_CONNECTIONS", 100, problems),
      maxConnectionsPerActor: positiveInteger(
        env,
        "API_STREAM_MAX_CONNECTIONS_PER_ACTOR",
        5,
        problems,
      ),
    },
    trustedClientIpHeader,
  };
  if (problems.length > 0) throw new ApiConfigError(problems);
  return config;
}
