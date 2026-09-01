import { afterEach, describe, expect, test } from "bun:test";
import {
  getProjectDeepLink,
  getWorkerAppBaseUrl,
} from "./notifications";

const originalNodeEnv = process.env.NODE_ENV;
const originalWorkerAppBaseUrl = process.env.WORKER_APP_BASE_URL;

function restoreEnv(
  name: "NODE_ENV" | "WORKER_APP_BASE_URL",
  value: string | undefined,
) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv("NODE_ENV", originalNodeEnv);
  restoreEnv("WORKER_APP_BASE_URL", originalWorkerAppBaseUrl);
});

describe("worker notification links", () => {
  test("skips production notifications when WORKER_APP_BASE_URL is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.WORKER_APP_BASE_URL;
    const messages: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      expect(getWorkerAppBaseUrl()).toBeNull();
    } finally {
      console.error = originalError;
    }

    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toMatchObject({
      level: "error",
      message: "worker_app_base_url_missing",
      action: "notification_send_skipped",
    });
  });

  test("rejects localhost notification links in production", () => {
    process.env.NODE_ENV = "production";
    process.env.WORKER_APP_BASE_URL = "http://localhost:3000";
    const originalError = console.error;
    console.error = () => {};

    try {
      expect(getProjectDeepLink("project-1")).toBeNull();
    } finally {
      console.error = originalError;
    }
  });

  test("keeps the localhost default outside production", () => {
    process.env.NODE_ENV = "development";
    delete process.env.WORKER_APP_BASE_URL;

    expect(getProjectDeepLink("project/with spaces")).toBe(
      "http://localhost:3000/projects/project%2Fwith%20spaces",
    );
  });
});
