import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const projectId = "40000000-0000-4000-8000-000000000001";
const roundId = "40000000-0000-4000-8000-000000000002";
const recipientId = "40000000-0000-4000-8000-000000000003";
const failedNotificationId = "40000000-0000-4000-8000-000000000004";
const pendingNotificationId = "40000000-0000-4000-8000-000000000005";
const commentId = "40000000-0000-4000-8000-000000000006";
const exportId = "40000000-0000-4000-8000-000000000007";
const clipId = "40000000-0000-4000-8000-000000000008";
const variantId = "40000000-0000-4000-8000-000000000009";

const browser = new Window({
  url: `http://localhost:3000/projects/${projectId}?tab=review`,
});
const originalFetch = globalThis.fetch;
const browserGlobalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "MutationObserver",
  "ResizeObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalBrowserGlobals = new Map(
  browserGlobalKeys.map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);

let ReviewPanel: typeof import("./review-panel").ReviewPanel;
type ReviewCreationAccess = import("./review-creation-access").ReviewCreationAccess;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let root: Root | null = null;

function installBrowserGlobals() {
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      browser.setTimeout(() => callback(browser.performance.now()), 0),
    cancelAnimationFrame: (handle: number) => browser.clearTimeout(handle),
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
}

function notification(options: {
  id: string;
  status: "pending" | "failed";
  failureCode: string;
}) {
  return {
    id: options.id,
    recipientId,
    kind: "round_invitation",
    status: options.status,
    attemptCount: 1,
    nextAttemptAt: "2026-08-31T12:05:00.000Z",
    failureCode: options.failureCode,
    sentAt: null,
    createdAt: "2026-08-31T12:00:00.000Z",
    retryOfNotificationId: null,
  };
}

function workspace(options: {
  notifications?: ReturnType<typeof notification>[];
} = {}) {
  return {
    project: {
      id: projectId,
      title: "Launch campaign",
      approvalRequired: true,
    },
    candidates: [],
    rounds: [
      {
        id: roundId,
        revision: 1,
        status: "open",
        responsesOpen: true,
        title: "Launch review",
        message: null,
        sentAt: "2026-08-31T12:00:00.000Z",
        expiresAt: null,
        allowDownloads: false,
        approvalRequired: true,
        decision: null,
        newerWorkAvailable: false,
        items: [],
        recipients: [
          {
            id: recipientId,
            role: "reviewer",
            email: "reviewer@example.test",
            createdAt: "2026-08-31T12:00:00.000Z",
          },
        ],
        notifications: options.notifications ?? [],
        comments: [
          {
            id: commentId,
            itemId: null,
            parentId: null,
            authorKind: "guest",
            authorName: "Client reviewer",
            body: "Please tighten the opening.",
            timestampSec: null,
            resolvedAt: null,
            editedAt: null,
            createdAt: "2026-08-31T12:10:00.000Z",
          },
        ],
        auditEvents: [],
      },
    ],
  };
}

async function renderPanel(options: {
  canManageReview: boolean;
  creationAccess?: ReviewCreationAccess;
}) {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => {
    root?.render(
      <ChakraProvider value={system}>
        <ReviewPanel
          projectId={projectId}
          canManageReview={options.canManageReview}
          creationAccess={
            options.creationAccess ??
            (options.canManageReview ? "available" : "capability_denied")
          }
        />
      </ChakraProvider>,
    );
    await browser.happyDOM.waitUntilComplete();
  });
  return container;
}

function button(container: HTMLElement, label: string) {
  return [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

beforeAll(async () => {
  installBrowserGlobals();
  ({ ReviewPanel } = await import("./review-panel"));
  ({ ChakraProvider } = await import("@chakra-ui/react"));
  ({ system } = await import("@narriflow/ui/theme"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  browser.document.body.replaceChildren();
  browser.sessionStorage.clear();
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  browser.close();
  for (const key of browserGlobalKeys) {
    const descriptor = originalBrowserGlobals.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe("ReviewPanel mutation authorization", () => {
  test("retains review creation state and its key after a malformed success response", async () => {
    const current = workspace();
    current.candidates = [
      {
        id: exportId,
        clipId,
        editorRevision: 3,
        createdAt: "2026-08-31T12:00:00.000Z",
        clip: {
          title: "Campaign clip",
          index: 0,
          startSec: 0,
          endSec: 30,
          editorRevision: 3,
        },
        variants: [
          {
            id: variantId,
            aspectRatio: "ratio_9_16",
            resolution: "1080p",
            durationSec: 30,
            status: "completed",
          },
        ],
      },
    ];
    current.rounds[0]!.newerWorkAvailable = true;
    const idempotencyKeys: string[] = [];
    globalThis.fetch = mock(async (request, init) => {
      const url = String(request);
      if ((init?.method ?? "GET") === "GET") return Response.json(current);
      if (url === `/api/projects/${projectId}/review-rounds`) {
        const key = new Headers(init?.headers).get("Idempotency-Key");
        if (key) idempotencyKeys.push(key);
        const token = "a".repeat(43);
        return Response.json({
          id: roundId,
          revision: 2,
          createdAt: "2026-08-31T12:15:00.000Z",
          token,
          path: `/review/${token}`,
          notificationIds: [],
          replayed: false,
          delivery: [],
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;

    const container = await renderPanel({ canManageReview: true });
    await act(async () => {
      button(container, "Prepare next round")?.click();
      await browser.happyDOM.waitUntilComplete();
    });
    const candidateToggle = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;
    expect(candidateToggle).not.toBeNull();
    await act(async () => {
      candidateToggle?.click();
      await browser.happyDOM.waitUntilComplete();
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await act(async () => {
        button(container, "Send next round")?.click();
        await browser.happyDOM.waitUntilComplete();
      });
    }

    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    expect(container.textContent).toContain("Campaign clip");
    expect(container.textContent).toContain("Review creation response was incomplete");
  });

  test("keeps rounds and comments readable without review.manage and hides every mutation", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        workspace({
          notifications: [
            notification({
              id: failedNotificationId,
              status: "failed",
              failureCode: "delivery_attempts_exhausted",
            }),
          ],
        }),
      ),
    ) as typeof fetch;

    const container = await renderPanel({
      canManageReview: false,
      creationAccess: "capability_denied",
    });

    expect(container.textContent).toContain("Round 1 · Launch review");
    expect(container.textContent).toContain("Please tighten the opening.");
    expect(container.textContent).toContain("delivery_attempts_exhausted");
    expect(container.textContent).toContain("Review desk is view-only");
    for (const label of [
      "Send review",
      "Resend",
      "Revoke",
      "Retry",
      "Reply",
      "Resolve",
      "Reopen",
      "Post comment",
    ]) {
      expect(button(container, label)).toBeUndefined();
    }
  });

  test("shows a manual Retry only for a terminal failed delivery", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        workspace({
          notifications: [
            notification({
              id: pendingNotificationId,
              status: "pending",
              failureCode: "provider_temporary_failure",
            }),
            notification({
              id: failedNotificationId,
              status: "failed",
              failureCode: "delivery_attempts_exhausted",
            }),
          ],
        }),
      ),
    ) as typeof fetch;

    const container = await renderPanel({ canManageReview: true });
    const retryButtons = [...container.querySelectorAll("button")].filter(
      (entry) => entry.textContent?.trim() === "Retry",
    );

    expect(container.textContent).toContain("provider_temporary_failure");
    expect(container.textContent).toContain("delivery_attempts_exhausted");
    expect(retryButtons).toHaveLength(1);
    expect(retryButtons[0]?.parentElement?.textContent).toContain(
      "delivery_attempts_exhausted",
    );
  });

  test("replays the resend intent when the mutation succeeds but reload fails", async () => {
    const idempotencyKeys: string[] = [];
    let initialLoadComplete = false;
    globalThis.fetch = mock(async (request, init) => {
      const url = String(request);
      if ((init?.method ?? "GET") === "GET") {
        if (!initialLoadComplete) {
          initialLoadComplete = true;
          return Response.json(workspace());
        }
        return Response.json({ code: "reload_failed" }, { status: 503 });
      }
      if (url === `/api/projects/${projectId}/review-rounds/${roundId}/resend`) {
        const body = JSON.parse(String(init?.body)) as {
          idempotencyKey: string;
        };
        idempotencyKeys.push(body.idempotencyKey);
        return Response.json({ notificationId: failedNotificationId });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;

    const container = await renderPanel({ canManageReview: true });
    await act(async () => {
      button(container, "Resend")?.click();
      await browser.happyDOM.waitUntilComplete();
    });
    await act(async () => {
      button(container, "Resend")?.click();
      await browser.happyDOM.waitUntilComplete();
    });

    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    expect(container.textContent).toContain(
      "Review link resent. Refresh the page to load the latest review status.",
    );
  });

  test("replays the notification retry intent when the mutation succeeds but reload fails", async () => {
    const idempotencyKeys: string[] = [];
    let initialLoadComplete = false;
    globalThis.fetch = mock(async (request, init) => {
      const url = String(request);
      if ((init?.method ?? "GET") === "GET") {
        if (!initialLoadComplete) {
          initialLoadComplete = true;
          return Response.json(
            workspace({
              notifications: [
                notification({
                  id: failedNotificationId,
                  status: "failed",
                  failureCode: "delivery_attempts_exhausted",
                }),
              ],
            }),
          );
        }
        return Response.json({ code: "reload_failed" }, { status: 503 });
      }
      if (
        url ===
        `/api/projects/${projectId}/review-rounds/${roundId}/notifications/${failedNotificationId}/retry`
      ) {
        const body = JSON.parse(String(init?.body)) as {
          idempotencyKey: string;
        };
        idempotencyKeys.push(body.idempotencyKey);
        return Response.json({ notificationId: pendingNotificationId });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;

    const container = await renderPanel({ canManageReview: true });
    await act(async () => {
      button(container, "Retry")?.click();
      await browser.happyDOM.waitUntilComplete();
    });
    await act(async () => {
      button(container, "Retry")?.click();
      await browser.happyDOM.waitUntilComplete();
    });

    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    expect(container.textContent).toContain(
      "Delivery retried. Refresh the page to load the latest review status.",
    );
  });
});
