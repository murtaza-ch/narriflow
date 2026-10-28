import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { ApiError } from "@narriflow/api-client";
import type { SocialAccountSnapshot } from "@narriflow/validators";
import type { SocialAccountsApi } from "./social-accounts-panel";

const browser = new Window({ url: "http://localhost:3000/settings/social-accounts" });
const replace = mock(() => undefined);
const notify = mock(() => undefined);
const confirm = mock(async () => false);
const api = {
	startConnect: mock(async (_platform: string, _redirect: string) => "https://provider.example/authorize"),
	facebookPages: mock(async (_token: string, _signal?: AbortSignal) => [] as Array<{ id: string; name: string | null; avatarUrl: string | null }>),
	selectFacebookPage: mock(async (_token: string, _pageId: string) => ({ displayName: "My Page" })),
	disconnect: mock(async (_accountId: string) => ({ ok: true })),
	onChanged: mock(() => undefined),
	navigate: mock((_url: string) => undefined),
} satisfies SocialAccountsApi;
mock.module("next/navigation", () => ({ useRouter: () => ({ replace }), usePathname: () => "/settings/social-accounts" }));
mock.module("@narriflow/ui/components/toaster", () => ({ toaster: { create: notify } }));
mock.module("@narriflow/ui/components/confirm-dialog", () => ({ useConfirm: () => ({ confirm, dialog: null }) }));
let Panel: typeof import("./social-accounts-panel").SocialAccountsPanel;
let ChakraProvider: typeof import("@chakra-ui/react").ChakraProvider;
let system: typeof import("@narriflow/ui/theme").system;
let root: Root;
const account: SocialAccountSnapshot = { id: "one", platform: "youtube_shorts", providerAccountId: "channel", displayName: "My channel", handle: "@channel", avatarUrl: null, scopes: [], expiresAt: null, status: "active", publishingEligible: true, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" };

beforeAll(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (cb: FrameRequestCallback) => browser.setTimeout(() => cb(0), 0), cancelAnimationFrame: (id: number) => browser.clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true });
  ({ SocialAccountsPanel: Panel } = await import("./social-accounts-panel"));
  ({ ChakraProvider } = await import("@chakra-ui/react"));
  ({ system } = await import("@narriflow/ui/theme"));
});
async function render(overrides: Partial<Parameters<typeof Panel>[0]> = {}) {
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(<ChakraProvider value={system}><Panel accounts={[]} api={api} connectedCount={null} errorCode={null} facebookSelectionToken={null} canManage access={{ role: "owner", status: "active" }} accountLimit={3} connectRequirement={null} connectUpgrade={null} canManageBilling {...overrides} /></ChakraProvider>); });
  return container;
}
async function settle() { await act(async () => { await browser.happyDOM.waitUntilComplete(); }); }
afterEach(async () => { await act(async () => root?.unmount()); browser.document.body.replaceChildren(); for (const fn of Object.values(api)) fn.mockClear(); confirm.mockClear(); notify.mockClear(); replace.mockClear(); });
afterAll(() => browser.close());

test("empty state has six labeled connect buttons in platform order", async () => {
  const dom = await render();
  expect(dom.textContent).toContain("Connect your first social account");
  const tiles = [...dom.querySelectorAll("button")];
  expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual(["Connect TikTok account", "Connect YouTube account", "Connect Instagram account", "Connect Facebook account (publishing coming soon)", "Connect X account", "Connect LinkedIn account"]);
  expect(dom.querySelectorAll("a").length).toBe(0);
  expect(tiles[3]?.textContent).toContain("Publishing coming soon");
});
test("connecting asks the API first and only then navigates to the provider", async () => {
  const dom = await render({ returnTo: "/projects/abc?publishClips=def" });
  await act(async () => { (dom.querySelectorAll("button")[1] as unknown as HTMLElement).click(); });
  expect(api.startConnect).toHaveBeenCalledWith("youtube_shorts", "/projects/abc?publishClips=def");
  expect(api.navigate).toHaveBeenCalledWith("https://provider.example/authorize");
});
test("a refused connection stays on the page with the reason", async () => {
  api.startConnect.mockRejectedValueOnce(new ApiError({ code: "social_provider_unavailable", message: "Unavailable", status: 503 }));
  const dom = await render();
  await act(async () => { (dom.querySelectorAll("button")[0] as unknown as HTMLElement).click(); });
  expect(api.navigate).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Connection failed" }));
});
test("a connected Facebook Page shows publishing as coming soon", async () => {
  const dom = await render({ accounts: [{ ...account, id: "facebook", platform: "facebook_reels", displayName: "Brand Page" }] });
  const card = [...dom.querySelectorAll("p")].find((node) => node.textContent === "Brand Page")?.parentElement;
  expect(card?.textContent).toContain("Publishing coming soon");
});
test("multiple profiles precede add cards and read-only users cannot manage", async () => {
  const dom = await render({ accounts: [account, { ...account, id: "two", displayName: "Second channel", status: "expired" }], canManage: false, access: { role: "viewer", status: "active" } });
  expect(dom.textContent).toContain("Second channel");
  expect(dom.textContent).toContain("expired");
  expect(dom.textContent.indexOf("Second channel")).toBeLessThan(dom.textContent.indexOf("Add an account"));
  expect(dom.querySelectorAll("a, button").length).toBe(0);
  expect(dom.textContent).toContain("Ask a workspace owner or admin to connect a social account.");
});
test("a restricted owner is sent to billing instead of told to ask an admin", async () => {
  const dom = await render({ canManage: false, access: { role: "owner", status: "restricted" } });
  expect(dom.textContent).toContain("Fix billing to connect a social account.");
  expect(dom.textContent).not.toContain("Ask a workspace owner");
  expect([...dom.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["/settings/billing"]);
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
  expect(api.disconnect).not.toHaveBeenCalled();
});
test("failed disconnect reports failure and keeps the profile", async () => {
  confirm.mockResolvedValueOnce(true);
  api.disconnect.mockRejectedValueOnce(new ApiError({ code: "internal_error", message: "Failed", status: 500 }));
  const dom = await render({ accounts: [account] });
  await act(async () => { dom.querySelector("button")?.click(); });
  expect(api.disconnect).toHaveBeenCalledWith("one");
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Could not disconnect" }));
  expect(dom.textContent).toContain("My channel");
  expect(api.onChanged).not.toHaveBeenCalled();
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
  api.facebookPages.mockResolvedValueOnce([{ id: "page-one", name: "My Page", avatarUrl: null }]);
  const dom = await render({ facebookSelectionToken: "selection" }); await settle();
  expect(dom.textContent).toContain("Choose one Facebook Page");
  await act(async () => { dom.querySelector("button")?.click(); });
  expect(api.selectFacebookPage).toHaveBeenCalledWith("selection", "page-one");
  expect(api.onChanged).toHaveBeenCalledTimes(1);
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
