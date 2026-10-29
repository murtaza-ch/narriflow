import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createApiRuntime } from "@narriflow/api-client";

const browser = new Window({ url: "http://localhost:3000/settings/api" });
const USER = "user_test";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const scope = { userId: USER, workspaceId: WORKSPACE };

type Reply = () => Response;
let replies: Reply[] = [];
const sent: Array<{ url: string; key: string | null }> = [];
const fakeFetch = (async (input: unknown, init: RequestInit = {}) => {
  sent.push({ url: String(input), key: new Headers(init.headers).get("idempotency-key") });
  const reply = replies.shift();
  if (!reply) throw new Error("unexpected request");
  return reply();
}) as typeof fetch;

const runtime = createApiRuntime({ baseUrl: "http://api.test", getToken: async () => "token", fetch: fakeFetch });
runtime.setIdentity(USER);
runtime.selectWorkspace(WORKSPACE);
mock.module("@/app/_components/api-provider", () => ({ useApiRuntime: () => runtime }));

const json = (body: unknown, status: number) => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "X-Workspace-Id": WORKSPACE } });

let CallbackSecretPanel: typeof import("./callback-secret-panel").CallbackSecretPanel;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let QueryClientProvider: typeof import("@tanstack/react-query").QueryClientProvider;
let system: typeof import("@narriflow/ui/theme").system;
let root: Root;

beforeAll(async () => {
  Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, 
    Element: browser.Element, Node: browser.Node, Event: browser.Event, MouseEvent: browser.MouseEvent,
    MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: (cb: FrameRequestCallback) => browser.setTimeout(() => cb(0), 0),
    cancelAnimationFrame: (id: number) => browser.clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true,
  });
  ({ CallbackSecretPanel } = await import("./callback-secret-panel"));
  ({ ChakraProvider } = await import("@chakra-ui/react"));
  ({ QueryClientProvider } = await import("@tanstack/react-query"));
  ({ system } = await import("@narriflow/ui/theme"));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  browser.document.body.replaceChildren();
  replies = [];
  sent.length = 0;
});
afterAll(() => browser.close());

async function mount(node: React.ReactNode) {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(
      <ChakraProvider value={system}>
        <QueryClientProvider client={runtime.queryClient}>{node}</QueryClientProvider>
      </ChakraProvider>,
    );
  });
  return container;
}

const click = async (element: Element | null | undefined) => {
  await act(async () => (element as unknown as HTMLElement).click());
  await act(async () => { await browser.happyDOM.waitUntilComplete(); });
};
const button = (dom: Element, label: string) => [...dom.querySelectorAll("button")].find((node) => node.textContent?.includes(label));

const status = { current: { createdAt: "2030-01-01T00:00:00.000Z" }, previousRetiresAt: null };

test("a rotated signing secret is shown once, kept out of the cache, and a lost response is not recoverable by retrying", async () => {
  replies = [
    json({ createdAt: "2030-01-01T00:00:00.000Z", secret: "whsec_one-time-value" }, 201),
    json({ error: "credential_already_issued", message: "This signing secret was already created, and a secret can't be shown a second time.", requestId: "r1" }, 409),
  ];
  const dom = await mount(<CallbackSecretPanel scope={scope} status={status} />);
  await click(button(dom, "Rotate secret"));
  expect(dom.textContent).toContain("whsec_one-time-value");
  expect(dom.textContent).toContain("You won't see it again.");
  expect(sent[0]?.url).toBe("http://api.test/api/workspace/callback-signing-secret/rotate");
  expect(sent[0]?.key).toBeTruthy();
  // Neither the query cache nor the mutation cache holds the plaintext.
  expect(JSON.stringify(runtime.queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain("one-time-value");
  expect(JSON.stringify(runtime.queryClient.getMutationCache().getAll().map((mutation) => mutation.state.data ?? null))).not.toContain("one-time-value");

  // The next press is a new intent (the first completed), and the replay answer is the safe recovery message.
  await click(button(dom, "Rotate secret"));
  expect(sent[1]?.key).not.toBe(sent[0]?.key);
  expect(dom.textContent).toContain("can't be shown a second time");
});
