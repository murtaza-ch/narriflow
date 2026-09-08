import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import type { SocialAccountSnapshot } from "@narriflow/validators";

const browser = new Window({ url: "http://localhost:3000/settings/social-accounts" });
const replace = mock(() => undefined);
const refresh = mock(() => undefined);
const notify = mock(() => undefined);
const confirm = mock(async () => false);
const request = mock(async (_url: string, _options?: RequestInit) => Response.json({}));
mock.module("next/navigation", () => ({ useRouter: () => ({ replace, refresh }), usePathname: () => "/settings/social-accounts" }));
mock.module("@narriflow/ui/components/toaster", () => ({ toaster: { create: notify } }));
mock.module("@narriflow/ui/components/confirm-dialog", () => ({ useConfirm: () => ({ confirm, dialog: null }) }));
let Panel: typeof import("./social-accounts-panel").SocialAccountsPanel;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let root: Root;
const account: SocialAccountSnapshot = { id: "one", platform: "youtube_shorts", providerAccountId: "channel", displayName: "My channel", handle: "@channel", avatarUrl: null, scopes: [], expiresAt: null, status: "active", createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" };

beforeAll(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (cb: FrameRequestCallback) => browser.setTimeout(() => cb(0), 0), cancelAnimationFrame: (id: number) => browser.clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true });
  ({ SocialAccountsPanel: Panel } = await import("./social-accounts-panel"));
  ({ ChakraProvider } = await import("@chakra-ui/react"));
  ({ system } = await import("@narriflow/ui/theme"));
});
async function render(overrides: Partial<Parameters<typeof Panel>[0]> = {}) {
  globalThis.fetch = request as unknown as typeof fetch;
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(<ChakraProvider value={system}><Panel accounts={[]} connectedCount={null} errorCode={null} facebookSelectionToken={null} canManage {...overrides} /></ChakraProvider>); });
  return container;
}
async function settle() { await act(async () => { await browser.happyDOM.waitUntilComplete(); }); }
afterEach(async () => { await act(async () => root?.unmount()); browser.document.body.replaceChildren(); request.mockClear(); confirm.mockClear(); notify.mockClear(); replace.mockClear(); refresh.mockClear(); });
afterAll(() => browser.close());

test("empty state has six labeled OAuth links in platform order", async () => {
  const dom = await render();
  expect(dom.textContent).toContain("Connect your first social account");
  const links = [...dom.querySelectorAll("a")];
  expect(links.map((link) => link.getAttribute("aria-label"))).toEqual(["Connect TikTok account", "Connect YouTube account", "Connect Instagram account", "Connect Facebook account", "Connect X account", "Connect LinkedIn account"]);
  expect(links[3]?.getAttribute("href")).toBe("/api/social/oauth/start/facebook_reels?redirect=/settings/social-accounts");
});
test("multiple profiles precede add cards and read-only users cannot manage", async () => {
  const dom = await render({ accounts: [account, { ...account, id: "two", displayName: "Second channel", status: "expired" }], canManage: false });
  expect(dom.textContent).toContain("Second channel");
  expect(dom.textContent).toContain("expired");
  expect(dom.textContent.indexOf("Second channel")).toBeLessThan(dom.textContent.indexOf("Add an account"));
  expect(dom.querySelectorAll("a, button").length).toBe(0);
});
test("failed provider avatars fall back to the profile initial", async () => {
  const dom = await render({ accounts: [{ ...account, avatarUrl: "https://images.example.test/broken.jpg" }] });
  const avatar = dom.querySelector('img[src="https://images.example.test/broken.jpg"]');
  expect(avatar).not.toBeNull();
  await act(async () => avatar?.dispatchEvent(new browser.Event("error")));
  expect(dom.textContent).toContain("M");
  expect(dom.querySelector('img[src="https://images.example.test/broken.jpg"]')).toBeNull();
});
test("canceling disconnect makes no request", async () => {
  confirm.mockResolvedValueOnce(false);
  const dom = await render({ accounts: [account] });
  await act(async () => { dom.querySelector("button")?.click(); });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
});
test("failed disconnect reports failure and keeps the profile", async () => {
  confirm.mockResolvedValueOnce(true);
  request.mockResolvedValueOnce(Response.json({}, { status: 500 }));
  const dom = await render({ accounts: [account] });
  await act(async () => { dom.querySelector("button")?.click(); });
  expect(request).toHaveBeenCalledWith("/api/social/accounts/one", { method: "DELETE" });
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Could not disconnect" }));
  expect(dom.textContent).toContain("My channel");
  expect(refresh).not.toHaveBeenCalled();
});
test("OAuth callback success is announced and cleared", async () => {
  await render({ connectedCount: 2 }); await settle();
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Connected 2 accounts" }));
  expect(replace).toHaveBeenCalledWith("/settings/social-accounts", { scroll: false });
});
test("OAuth callback failure is announced and cleared", async () => {
  await render({ errorCode: "unknown" }); await settle();
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Connection failed" }));
  expect(replace).toHaveBeenCalledTimes(1);
});
test("Facebook selection keeps the Page choice before the platform cards", async () => {
  request.mockResolvedValueOnce(Response.json({ pages: [{ id: "page-one", name: "My Page", avatarUrl: null }] }));
  const dom = await render({ facebookSelectionToken: "selection" }); await settle();
  expect(dom.textContent).toContain("Choose one Facebook Page");
  request.mockResolvedValueOnce(Response.json({ account: { displayName: "My Page" } }));
  await act(async () => { dom.querySelector("button")?.click(); });
  expect(request).toHaveBeenLastCalledWith("/api/social/oauth/facebook-selection/selection", expect.objectContaining({ method: "POST", body: JSON.stringify({ pageId: "page-one" }) }));
  expect(refresh).toHaveBeenCalledTimes(1);
});

test("settings navigation keeps long workspace names and respects developer permissions", async () => {
  const { SettingsChrome } = await import("../../_components/settings-chrome");
  const markup = renderToStaticMarkup(<ChakraProvider value={system}><SettingsChrome workspaceName="A very long workspace name shared by the whole editorial team" canManageApi={false} backHref="/calendar?month=2026-10" account={null} themeToggle={null}><p>Settings content</p></SettingsChrome></ChakraProvider>);
  expect(markup).toContain("A very long workspace name shared by the whole editorial team");
  expect(markup).not.toContain("Developer access");
  expect(markup).toContain('aria-current="page"');
  expect(markup).toContain('/calendar?month=2026-10');
  expect(markup).not.toContain("Search workspace");
});
