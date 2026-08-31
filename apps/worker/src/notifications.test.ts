import { afterEach, describe, expect, test } from "bun:test";
import {
  getProjectDeepLink,
  getWorkerAppBaseUrl,
  reportReviewNotificationWorkerConfiguration,
  resolveReviewNotificationWorkerConfiguration,
  reviewNotificationWorkerHealth,
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

describe("Review Notification worker configuration", () => {
  test("keeps readiness healthy when notification admission is disabled", () => {
    const configuration = resolveReviewNotificationWorkerConfiguration(
      { NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS: "0" },
      () => null,
    );

    expect(configuration).toEqual({ enabled: false, ready: true });
    expect(reviewNotificationWorkerHealth(configuration)).toEqual({
      enabled: false,
      ready: true,
      failureCode: null,
    });
  });

  test("makes readiness unhealthy and reports one content-safe failure for invalid secrets", () => {
    const accessSecret = "too-short-private-access-secret";
    const configuration = resolveReviewNotificationWorkerConfiguration(
      {
        NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS: "1",
        REVIEW_ACCESS_SECRET: accessSecret,
        REVIEW_SESSION_SECRET: "",
        RESEND_API_KEY: "resend-test-key",
      },
      () => "https://app.example.test",
    );
    const messages: string[] = [];

    reportReviewNotificationWorkerConfiguration(configuration, (message) => {
      messages.push(message);
    });

    expect(configuration).toMatchObject({
      enabled: true,
      ready: false,
      failureCode: "review_notification_worker_configuration_invalid",
      invalidFields: ["REVIEW_ACCESS_SECRET", "REVIEW_SESSION_SECRET"],
    });
    expect(reviewNotificationWorkerHealth(configuration)).toEqual({
      enabled: true,
      ready: false,
      failureCode: "review_notification_worker_configuration_invalid",
    });
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toEqual({
      level: "error",
      message: "review_notification_worker_configuration_invalid",
      invalidFields: ["REVIEW_ACCESS_SECRET", "REVIEW_SESSION_SECRET"],
      action: "review_notification_delivery_paused",
    });
    expect(messages[0]).not.toContain(accessSecret);
  });

  test("makes readiness unhealthy when Review delivery has no email provider key", () => {
    const configuration = resolveReviewNotificationWorkerConfiguration(
      {
        NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS: "1",
        REVIEW_ACCESS_SECRET: "a".repeat(32),
        REVIEW_SESSION_SECRET: "b".repeat(32),
      },
      () => "https://app.example.test",
    );
    const messages: string[] = [];

    reportReviewNotificationWorkerConfiguration(configuration, (message) => {
      messages.push(message);
    });

    expect(configuration).toMatchObject({
      enabled: true,
      ready: false,
      failureCode: "review_notification_worker_configuration_invalid",
      invalidFields: ["RESEND_API_KEY"],
    });
    expect(reviewNotificationWorkerHealth(configuration)).toEqual({
      enabled: true,
      ready: false,
      failureCode: "review_notification_worker_configuration_invalid",
    });
    expect(JSON.parse(messages[0]!)).toEqual({
      level: "error",
      message: "review_notification_worker_configuration_invalid",
      invalidFields: ["RESEND_API_KEY"],
      action: "review_notification_delivery_paused",
    });
  });

  test("returns the validated delivery configuration without exposing it in health", () => {
    const configuration = resolveReviewNotificationWorkerConfiguration(
      {
        NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS: "1",
        REVIEW_ACCESS_SECRET: "a".repeat(32),
        REVIEW_SESSION_SECRET: "b".repeat(32),
        RESEND_API_KEY: "resend-test-key",
      },
      () => "https://app.example.test",
    );

    expect(configuration).toMatchObject({
      enabled: true,
      ready: true,
      appBaseUrl: "https://app.example.test",
    });
    expect(reviewNotificationWorkerHealth(configuration)).toEqual({
      enabled: true,
      ready: true,
      failureCode: null,
    });
  });
});
