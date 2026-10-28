import type { AuthProvider } from "@prisma/client";

/** Pure readers for Clerk user payloads: webhook JSON (snake_case) and backend `User` objects (camelCase). */

export function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value) : null;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed;
  }

  return null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function getValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }

  return undefined;
}

export function getString(record: Record<string, unknown>, keys: string[]): string | null {
  const value = getValue(record, keys);
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  return asRecord(getValue(record, keys));
}

function getArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  const value = getValue(record, keys);
  return Array.isArray(value) ? value : [];
}

function getEmailFromEntry(entry: Record<string, unknown>): string | null {
  return getString(entry, ["email_address", "emailAddress"]);
}

function getPrimaryEmailEntry(user: Record<string, unknown>): Record<string, unknown> | null {
  const primaryFromObject = getRecord(user, ["primaryEmailAddress", "primary_email_address"]);
  if (primaryFromObject) {
    return primaryFromObject;
  }

  const emailEntries = getArray(user, ["email_addresses", "emailAddresses"])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  const primaryEmailAddressId = getString(user, ["primary_email_address_id", "primaryEmailAddressId"]);

  if (primaryEmailAddressId) {
    const preferred = emailEntries.find((entry) => getString(entry, ["id"]) === primaryEmailAddressId);
    if (preferred) {
      return preferred;
    }
  }

  return emailEntries[0] ?? null;
}

export function extractPrimaryEmail(user: Record<string, unknown>): string | null {
  const primaryEntry = getPrimaryEmailEntry(user);
  if (!primaryEntry) {
    return null;
  }

  return getEmailFromEntry(primaryEntry);
}

export function extractPrimaryEmailVerifiedAt(user: Record<string, unknown>): Date | null {
  const primaryEntry = getPrimaryEmailEntry(user);

  if (!primaryEntry) {
    return null;
  }

  const verification = getRecord(primaryEntry, ["verification"]);
  const verificationStatus = verification ? getString(verification, ["status"]) : null;

  if (verificationStatus !== "verified") {
    return null;
  }

  const emailUpdatedAt = parseDate(getValue(primaryEntry, ["updated_at", "updatedAt"]));
  if (emailUpdatedAt) {
    return emailUpdatedAt;
  }

  const verificationUpdatedAt = verification
    ? parseDate(getValue(verification, ["updated_at", "updatedAt"]))
    : null;
  if (verificationUpdatedAt) {
    return verificationUpdatedAt;
  }

  const userUpdatedAt = parseDate(getValue(user, ["updated_at", "updatedAt"]));
  if (userUpdatedAt) {
    return userUpdatedAt;
  }

  return new Date();
}

function mapProvider(value: string | null | undefined): AuthProvider | null {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();

  if (normalized.includes("google")) {
    return "google";
  }

  if (normalized.includes("apple")) {
    return "apple";
  }

  if (normalized.includes("microsoft")) {
    return "microsoft";
  }

  return null;
}

export interface ClerkIdentityShape {
  provider: AuthProvider;
  providerUserId: string;
  email: string | null;
}

export function extractIdentities(user: Record<string, unknown>): ClerkIdentityShape[] {
  const identities: ClerkIdentityShape[] = [];
  const primaryEmail = extractPrimaryEmail(user);
  const clerkUserId = getString(user, ["id"]);

  if (clerkUserId) {
    identities.push({
      provider: "email_password",
      providerUserId: clerkUserId,
      email: primaryEmail,
    });
  }

  const externalAccounts = getArray(user, ["external_accounts", "externalAccounts"])
    .map((account) => asRecord(account))
    .filter((account): account is Record<string, unknown> => account !== null);

  for (const account of externalAccounts) {
    const provider = mapProvider(getString(account, ["provider"]));
    const providerUserId = getString(account, ["provider_user_id", "providerUserId"]);

    if (!provider || !providerUserId) {
      continue;
    }

    identities.push({
      provider,
      providerUserId,
      email: getString(account, ["email_address", "emailAddress"]) ?? primaryEmail,
    });
  }

  return identities;
}
