import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "prisma/config";

function readDotEnvValue(requestedKey: string) {
  const currentValue = process.env[requestedKey]?.trim();

  if (currentValue) {
    return currentValue;
  }

  const envPath = resolve(process.cwd(), ".env");

  if (!existsSync(envPath)) {
    return null;
  }

  const contents = readFileSync(envPath, "utf8");

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const currentKey = line.slice(0, separatorIndex).trim();

    if (currentKey !== requestedKey) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value) {
      process.env[requestedKey] = value;
      return value;
    }
  }

  return null;
}

const databaseUrl = readDotEnvValue("DIRECT_URL") ?? readDotEnvValue("DATABASE_URL");

if (!databaseUrl) {
  throw new Error("DATABASE_URL or DIRECT_URL must be configured for Prisma");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
