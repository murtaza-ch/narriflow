import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useSyncExternalStore } from "react";
import { createRequire } from "node:module";
import type { Root } from "react-dom/client";
import type { AuthMode } from "@/lib/auth-entry";

const browser = new Window({ url: "http://localhost:3000/?auth=sign-in" });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, InputEvent: browser.InputEvent, MouseEvent: browser.MouseEvent, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver, requestAnimationFrame: (callback: FrameRequestCallback) => browser.setTimeout(() => callback(browser.performance.now()), 0), cancelAnimationFrame: (id: number) => browser.clearTimeout(id), getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
Object.defineProperty(browser, "isSecureContext", { value: true, configurable: true });
Object.defineProperty(browser, "PublicKeyCredential", { value: class {}, configurable: true });
let root: Root | null = null;
let container: HTMLDivElement;
const { ClerkWebAuthnError, ClerkRuntimeError, ClerkAPIResponseError } = createRequire(import.meta.resolve("@clerk/nextjs"))("@clerk/shared/error");
let navigationUrl = new URL("http://localhost:3000/");
const navigationListeners = new Set<() => void>();
function navigate(href: string) {
  navigationUrl = new URL(href, navigationUrl);
  for (const listener of navigationListeners) listener();
}
function useNavigationUrl() {
  return useSyncExternalStore((listener) => { navigationListeners.add(listener); return () => navigationListeners.delete(listener); }, () => navigationUrl.href);
}
const replace = mock((href: string) => navigate(href));
const activate = mock(async () => {});
const redirectWithAuth = mock(async (_href: string) => {});
const clerkClient = { redirectWithAuth };
let signin: any;
let signup: any;
let user: any;
let forceVerification = false;
let session: any;
let callbackProps: any;
mock.module("@clerk/nextjs", () => ({
  useClerk: () => clerkClient,
  useAuth: () => ({ isLoaded: true }),
  useSignIn: () => ({ isLoaded: true, signIn: signin, setActive: activate }),
  useSignUp: () => ({ isLoaded: true, signUp: signup, setActive: activate }),
  useUser: () => ({ isLoaded: true, isSignedIn: Boolean(user), user }),
  useSession: () => ({ session }),
  AuthenticateWithRedirectCallback: (props: any) => { callbackProps = props; return null; },
  useReverification: (operation: (...args: any[]) => Promise<unknown>, options: any) => async (...args: any[]) => {
    if (forceVerification) {
      await new Promise<void>((complete, reject) => options.onNeedsReverification({ level: "first_factor", complete, cancel: () => reject(new ClerkRuntimeError("Cancelled", { code: "reverification_cancelled" })) }));
    }
    return operation(...args);
  },
}));
mock.module("next/navigation", () => ({ useRouter: () => ({ replace, refresh: () => {} }), useSearchParams: () => new URL(useNavigationUrl()).searchParams, usePathname: () => new URL(useNavigationUrl()).pathname }));
mock.module("next/link", () => ({ default: ({ children, href, onClick }: any) => <a href={href} onClick={(event) => { onClick?.(event); if (!event.defaultPrevented) { event.preventDefault(); replace(href); } }}>{children}</a> }));
const { ChakraProvider, Dialog } = await import("@chakra-ui/react");
const { system } = await import("@narriflow/ui/theme");
const { AuthForm } = await import("./auth-form");
const { AuthModal } = await import("./auth-modal");
const { default: CallbackPage } = await import("../../sso-callback/[[...sso-callback]]/page");
const { PasskeySettings } = await import("../../(app)/settings/profile/passkey-settings");
const { ClerkOAuthContinuation } = await import("../../auth/continue/clerk-oauth-continuation");
const { HeaderAccountActions, StartLink } = await import("../../(marketing)/_components/account-actions");

beforeEach(() => {
  replace.mockClear(); activate.mockClear(); redirectWithAuth.mockReset(); redirectWithAuth.mockImplementation(async () => {}); forceVerification = false;
  navigationUrl = new URL("http://localhost:3000/"); callbackProps = null;
  session = { startVerification: mock(async () => ({ status: "needs_first_factor", supportedFirstFactors: [{ strategy: "password" }] })), attemptFirstFactorVerification: mock(async () => ({ status: "complete" })), verifyWithPasskey: mock(async () => ({ status: "complete" })) };
  signin = { status: null, firstFactorVerification: {}, secondFactorVerification: {}, supportedFirstFactors: [], supportedSecondFactors: [], prepareFirstFactor: mock(async () => signin), prepareSecondFactor: mock(async () => signin), create: mock(async () => ({ status: "complete", createdSessionId: "signed-in" })), authenticateWithRedirect: mock(async () => {}), authenticateWithPasskey: mock(async () => ({ status: "complete", createdSessionId: "passkey-session" })), attemptFirstFactor: mock(async () => ({ status: "complete", createdSessionId: "reset-session" })), attemptSecondFactor: mock(async () => ({ status: "complete", createdSessionId: "second-factor-session" })) };
  signup = { status: null, missingFields: [], unverifiedFields: [], verifications: { externalAccount: {}, emailAddress: {} }, prepareEmailAddressVerification: mock(async () => {}), create: mock(async () => { signup.status = "missing_requirements"; signup.unverifiedFields = ["email_address"]; return signup; }), update: mock(async () => { signup.missingFields = []; signup.unverifiedFields = ["email_address"]; return signup; }), attemptEmailAddressVerification: mock(async () => ({ status: "complete", createdSessionId: "signed-up" })), authenticateWithRedirect: mock(async () => {}) };
  user = { passkeys: [], createPasskey: mock(async () => {}), reload: mock(async () => {}) };
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; browser.document.body.replaceChildren(); });
afterAll(() => browser.close());

async function render(mode?: AuthMode, destination = "/projects/abc?clip=123") {
  container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ChakraProvider value={system}>{mode ? <Dialog.Root open><Dialog.Content><AuthForm mode={mode} destination={destination} /></Dialog.Content></Dialog.Root> : <PasskeySettings />}</ChakraProvider>);
    await browser.happyDOM.waitUntilComplete();
  });
}
async function enter(id: string, value: string) {
  await act(async () => {
    const input = browser.document.querySelector(`#${id}`) as unknown as HTMLInputElement;
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new browser.InputEvent("input", { bubbles: true, data: value }));
  });
}
async function submit() {
  await act(async () => {
    browser.document.querySelector("form")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
    await browser.happyDOM.waitUntilComplete();
  });
}
async function click(text: string) {
  await act(async () => {
    const button = [...browser.document.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
    if (!button) throw new Error(`Missing button: ${text}`);
    button.click();
    await new Promise((resolve) => browser.setTimeout(resolve, 0));
  });
}

describe("custom authentication forms", () => {
  test("external OAuth continuation uses Clerk's auth handoff and retries a failed navigation", async () => {
    redirectWithAuth.mockRejectedValueOnce(new Error("Navigation failed"));
    container = browser.document.createElement("div") as unknown as HTMLDivElement;
    browser.document.body.append(container);
    root = createRoot(container);
    const href = "https://example.clerk.accounts.dev/oauth/authorize-with-immediate-redirect?state=original";
    await act(async () => { root!.render(<ChakraProvider value={system}><ClerkOAuthContinuation href={href} /></ChakraProvider>); });
    expect(redirectWithAuth).toHaveBeenCalledWith(href);
    expect(browser.document.body.textContent).toContain("authorization page couldn’t open");
    await click("Try again");
    expect(redirectWithAuth).toHaveBeenCalledTimes(2);
    expect(browser.document.body.textContent).toContain("Opening the authorization page");
  });
  test("email registration and verification activate only a verified session", async () => {
    await render("sign-up");
    await enter("auth-email", "new@example.test"); await enter("auth-password", "test-password"); await submit();
    expect(signup.create).toHaveBeenCalledWith({ emailAddress: "new@example.test", password: "test-password" });
    expect(activate).not.toHaveBeenCalled();
    expect(browser.document.querySelector('label[for="auth-code"]')).not.toBeNull();
    await enter("auth-code", "424242"); await submit();
    expect(activate).toHaveBeenCalledWith({ session: "signed-up" });
    expect(replace).toHaveBeenCalledWith("/auth/continue?redirect_url=%2Fprojects%2Fabc%3Fclip%3D123");
  });
  test("password sign-in retains the original destination and keeps credentials out of links", async () => {
    await render("sign-in"); await enter("auth-email", "user@example.test"); await enter("auth-password", "test-password"); await submit();
    expect(signin.create).toHaveBeenCalledWith({ identifier: "user@example.test", password: "test-password" });
    expect(activate).toHaveBeenCalledWith({ session: "signed-in" });
    expect([...browser.document.querySelectorAll("a")].every((a) => !a.href.includes("test-password") && !a.href.includes("user%40"))).toBe(true);
  });
  test("mode tabs switch with the destination and give way to the footer once a code is pending", async () => {
    const link = (text: string) => [...browser.document.querySelectorAll("a")].find((a) => a.textContent === text);
    await render("sign-in");
    expect(link("Create account")?.getAttribute("href")).toBe("/?auth=sign-up&redirect_url=%2Fprojects%2Fabc%3Fclip%3D123");
    expect(link("Sign in")?.getAttribute("href")).toBe("/?auth=sign-in&redirect_url=%2Fprojects%2Fabc%3Fclip%3D123");
    await act(async () => root?.unmount());
    await render("sign-up"); await enter("auth-email", "new@example.test"); await enter("auth-password", "test-password"); await submit();
    expect(browser.document.querySelector("#auth-code")).not.toBeNull();
    expect(link("Create account")).toBeUndefined();
    expect(link("Sign in")?.getAttribute("href")).toBe("/?auth=sign-in&redirect_url=%2Fprojects%2Fabc%3Fclip%3D123");
  });
  test("password recovery stays in the modal and finishes through provisioning", async () => {
    signin.create = mock(async () => signin);
    await render("forgot-password"); await enter("auth-email", "user@example.test"); await submit();
    expect(signin.create).toHaveBeenCalledWith({ strategy: "reset_password_email_code", identifier: "user@example.test" });
    await enter("auth-code", "424242"); await enter("auth-password", "new-test-password"); await submit();
    expect(signin.attemptFirstFactor).toHaveBeenCalledWith({ strategy: "reset_password_email_code", code: "424242", password: "new-test-password" });
    expect(activate).toHaveBeenCalledWith({ session: "reset-session" });
  });
  test("OAuth missing-email completion asks for email and verification only", async () => {
    signup.status = "missing_requirements"; signup.missingFields = ["email_address"];
    await render("continue");
    expect(browser.document.querySelector("#auth-password")).toBeNull();
    await enter("auth-email", "provider@example.test"); await submit();
    expect(signup.update).toHaveBeenCalledWith({ emailAddress: "provider@example.test" });
    expect(browser.document.querySelector("#auth-code")).not.toBeNull();
  });
  test.each(["sign-in", "sign-up"] as const)("%s OAuth preserves callback and completion destinations", async (mode) => {
    await render(mode); await click("Continue with Apple");
    expect((mode === "sign-in" ? signin : signup).authenticateWithRedirect).toHaveBeenCalledWith({ strategy: "oauth_apple", redirectUrl: "/sso-callback?redirect_url=%2Fprojects%2Fabc%3Fclip%3D123", redirectUrlComplete: "/auth/continue?redirect_url=%2Fprojects%2Fabc%3Fclip%3D123" });
  });

  test("passkey sign-in activates the session and provisions before dashboard entry", async () => {
    await render("sign-in"); await click("Sign in with a passkey");
    expect(signin.authenticateWithPasskey).toHaveBeenCalledWith({ flow: "discoverable" });
    expect(activate).toHaveBeenCalledWith({ session: "passkey-session" });
    expect(replace).toHaveBeenCalledWith("/auth/continue?redirect_url=%2Fprojects%2Fabc%3Fclip%3D123");
  });
  test("refreshing a pending registration restores email verification", async () => {
    signup.status = "missing_requirements"; signup.unverifiedFields = ["email_address"]; signup.emailAddress = "pending@example.test";
    signup.verifications = { emailAddress: { strategy: "email_code", status: "unverified", expireAt: new Date(Date.now() + 60_000) } };
    await render("sign-up");
    expect(browser.document.querySelector("#auth-code")).not.toBeNull();
    expect(signup.prepareEmailAddressVerification).not.toHaveBeenCalled();
  });
  test("passkey cancellation leaves other methods available", async () => {
    signin.authenticateWithPasskey = mock(async () => { throw new ClerkWebAuthnError("The operation either timed out or was not allowed", { code: "passkey_retrieval_cancelled" }); });
    await render("sign-in"); await click("Sign in with a passkey");
    expect(browser.document.querySelector('[role="alert"]')?.textContent).toContain("cancelled");
    expect(browser.document.querySelector('[role="alert"]')?.textContent).not.toContain("Clerk:");
    expect((browser.document.querySelector("#auth-email") as unknown as HTMLInputElement).disabled).toBe(false);
    await click("Continue with Google"); expect(signin.authenticateWithRedirect).toHaveBeenCalledTimes(1);
  });
  test("unsupported browsers keep email and OAuth available", async () => {
    Object.defineProperty(browser, "PublicKeyCredential", { value: undefined, configurable: true });
    await render("sign-in");
    expect(container.textContent).not.toContain("Sign in with a passkey");
    expect(container.textContent).toContain("Continue with Microsoft");
    Object.defineProperty(browser, "PublicKeyCredential", { value: class {}, configurable: true });
  });
  test("duplicate submissions start one authentication attempt", async () => {
    let release!: () => void;
    signin.create = mock(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { status: "complete", createdSessionId: "once" }; });
    await render("sign-in");
    await act(async () => { const form = browser.document.querySelector("form")!; form.dispatchEvent(new browser.Event("submit", { bubbles: true })); form.dispatchEvent(new browser.Event("submit", { bubbles: true })); });
    expect(signin.create).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  test("OAuth needing email verification resumes even while its strategy is OAuth", async () => {
    signin.status = "needs_first_factor"; signin.identifier = "oauth@example.test";
    signin.firstFactorVerification = { strategy: "oauth_microsoft" };
    signin.supportedFirstFactors = [{ strategy: "email_code", emailAddressId: "email" }];
    await render("sign-in");
    expect(signin.prepareFirstFactor).toHaveBeenCalledWith({ strategy: "email_code", emailAddressId: "email" });
    expect(browser.document.querySelector("#auth-code")).not.toBeNull();
    await enter("auth-code", "424242"); await submit();
    expect(replace).toHaveBeenCalledWith("/auth/continue?redirect_url=%2Fprojects%2Fabc%3Fclip%3D123");
  });

  test.each(["needs_first_factor", "needs_second_factor"])("refreshing %s reuses a valid code", async (status) => {
    signin.status = status; signin.identifier = "pending@example.test";
    signin.supportedFirstFactors = signin.supportedSecondFactors = [{ strategy: "email_code", emailAddressId: "email" }];
    signin.firstFactorVerification = signin.secondFactorVerification = { strategy: "email_code", status: "unverified", expireAt: new Date(Date.now() + 60_000) };
    await render("sign-in");
    expect(browser.document.querySelector("#auth-code")).not.toBeNull();
    expect(signin.prepareFirstFactor).not.toHaveBeenCalled(); expect(signin.prepareSecondFactor).not.toHaveBeenCalled();
  });

  test("a pending reset does not become an email-code sign-in", async () => {
    signin.status = "needs_first_factor"; signin.firstFactorVerification = { strategy: "reset_password_email_code" };
    signin.supportedFirstFactors = [{ strategy: "email_code", emailAddressId: "email" }];
    await render("sign-in");
    expect(signin.prepareFirstFactor).not.toHaveBeenCalled();
    expect(browser.document.querySelector("#auth-code")).toBeNull();
    expect(container.textContent).toContain("Continue with Microsoft");
  });

  test.each(["sign-up", "sign-in", "forgot-password", "continue"] as const)("%s can replace an unfinished attempt with another email", async (mode) => {
    signup.status = "missing_requirements"; signup.unverifiedFields = ["email_address"]; signup.emailAddress = "typo@example.test";
    signin.status = "needs_first_factor"; signin.identifier = "typo@example.test";
    signin.firstFactorVerification = { strategy: mode === "forgot-password" ? "reset_password_email_code" : "email_code", status: "unverified", expireAt: new Date(Date.now() + 60_000) };
    signin.supportedFirstFactors = [{ strategy: "email_code", emailAddressId: "email" }];
    if (mode === "forgot-password") signin.create = mock(async () => signin);
    await render(mode); await click("Use a different email");
    expect(browser.document.querySelector("#auth-code")).toBeNull();
    expect((browser.document.querySelector("#auth-email") as unknown as HTMLInputElement).value).toBe("");
    await enter("auth-email", "correct@example.test");
    if (mode !== "forgot-password") await enter("auth-password", "test-password");
    await submit();
    if (mode === "sign-up" || mode === "continue") expect(signup.create).toHaveBeenCalledWith({ emailAddress: "correct@example.test", password: "test-password" });
    else if (mode === "forgot-password") expect(signin.create).toHaveBeenCalledWith({ strategy: "reset_password_email_code", identifier: "correct@example.test" });
    else expect(signin.create).toHaveBeenCalledWith({ identifier: "correct@example.test", password: "test-password" });
  });

  test("missing-email OAuth completion can restart with providers and password registration", async () => {
    signup.status = "missing_requirements"; signup.missingFields = ["email_address"];
    await render("continue"); await click("Use a different email");
    expect(browser.document.querySelector("#auth-password")).not.toBeNull();
    await click("Continue with Apple"); expect(signup.authenticateWithRedirect).toHaveBeenCalledTimes(1);
  });

  test.each(["sign-up", "sign-in"] as const)("%s displays the OAuth error stored on the Clerk resource", async (mode) => {
    const error = { code: "external_account_error", longMessage: "Provider consent was cancelled. Choose another method." };
    if (mode === "sign-up") signup.verifications.externalAccount.error = error;
    else signin.firstFactorVerification.error = error;
    await render(mode);
    expect(browser.document.querySelector('[role="alert"]')?.textContent).toBe(error.longMessage);
    await click("Continue with Google");
    expect((mode === "sign-up" ? signup : signin).authenticateWithRedirect).toHaveBeenCalledTimes(1);
  });

  test.each(["sign-up", "second-factor", "forgot-password"] as const)("%s handles wrong and expired codes, then a successful retry", async (flow) => {
    signup.status = "missing_requirements"; signup.unverifiedFields = ["email_address"];
    signin.status = flow === "second-factor" ? "needs_second_factor" : "needs_first_factor";
    signin.identifier = "user@example.test";
    signin.firstFactorVerification = { strategy: flow === "forgot-password" ? "reset_password_email_code" : "password" };
    signin.supportedSecondFactors = [{ strategy: "email_code", emailAddressId: "email" }];
    const attempt = flow === "sign-up" ? signup.attemptEmailAddressVerification : flow === "second-factor" ? signin.attemptSecondFactor : signin.attemptFirstFactor;
    for (const code of ["form_code_incorrect", "verification_expired"]) attempt.mockRejectedValueOnce(new ClerkAPIResponseError("API validation error", { status: 422, data: [{ code, message: "Try a new code", long_message: code === "form_code_incorrect" ? "That code is incorrect." : "That code has expired." }] }));
    await render(flow === "second-factor" ? "sign-in" : flow);
    if (flow === "forgot-password") await enter("auth-password", "new-test-password");
    await enter("auth-code", "111111"); await submit();
    expect(browser.document.querySelector('[role="alert"]')?.textContent).toContain("incorrect");
    expect(activate).not.toHaveBeenCalled();
    await enter("auth-code", "222222"); await submit();
    expect(browser.document.querySelector('[role="alert"]')?.textContent).toContain("expired");
    expect(activate).not.toHaveBeenCalled();
    await enter("auth-code", "424242"); await submit();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/auth/continue?redirect_url=%2Fprojects%2Fabc%3Fclip%3D123");
  });

  test("unexpected runtime failures use a fixed public message", async () => {
    signin.create.mockRejectedValueOnce(new Error("Clerk: internal configuration and developer details"));
    await render("sign-in"); await submit();
    expect(browser.document.querySelector('[role="alert"]')?.textContent).toContain("Please try again");
    expect(browser.document.querySelector('[role="alert"]')?.textContent).not.toContain("developer details");
  });
});

describe("optional passkey account settings", () => {
  test("enrolls a passkey through Clerk", async () => {
    await render(); await click("Add a passkey");
    expect(user.createPasskey).toHaveBeenCalledTimes(1); expect(user.reload).toHaveBeenCalledTimes(1);
  });

  test("cancelled passkey enrollment keeps account actions available", async () => {
    user.createPasskey = mock(async () => { throw new ClerkWebAuthnError("The operation either timed out or was not allowed", { code: "passkey_registration_cancelled" }); });
    await render(); await click("Add a passkey");
    expect(browser.document.querySelector('[role="alert"]')).not.toBeNull();
    expect(user.reload).not.toHaveBeenCalled();
    expect([...browser.document.querySelectorAll("button")].find((button) => button.textContent?.includes("Add a passkey"))?.disabled).toBe(false);
  });
  test("lists, renames, and removes Clerk passkeys", async () => {
    const passkey = { id: "key", name: "Old", createdAt: new Date(), lastUsedAt: null, update: mock(async () => {}), delete: mock(async () => {}) };
    user.passkeys = [passkey];
    await render(); await enter("passkey-key", "Laptop"); await click("Save name");
    expect(passkey.update).toHaveBeenCalledWith({ name: "Laptop" });
    await click("Remove"); expect(passkey.delete).toHaveBeenCalledTimes(1);
  });
  test("sensitive actions use the custom verification dialog", async () => {
    forceVerification = true;
    await render(); await click("Add a passkey");
    expect(user.createPasskey).not.toHaveBeenCalled();
    expect(browser.document.body.textContent).toContain("Verify it’s you");
    await enter("account-verification", "test-password"); await submit();
    expect(session.attemptFirstFactorVerification).toHaveBeenCalledWith({ strategy: "password", password: "test-password" });
    expect(user.createPasskey).toHaveBeenCalledTimes(1);
  });
  test("cancelled verification does not mutate credentials", async () => {
    forceVerification = true;
    await render(); await click("Add a passkey"); await click("Cancel");
    expect(user.createPasskey).not.toHaveBeenCalled();
    expect(browser.document.body.textContent).toContain("Verification cancelled");
  });
  test("passkey reverification cancellation shows a public message and allows retry", async () => {
    forceVerification = true;
    session.startVerification.mockResolvedValue({ status: "needs_first_factor", supportedFirstFactors: [{ strategy: "password" }, { strategy: "passkey" }] });
    session.verifyWithPasskey.mockRejectedValueOnce(new ClerkWebAuthnError("Internal Clerk message", { code: "passkey_retrieval_cancelled" }));
    await render(); await click("Add a passkey"); await click("Verify with a passkey");
    expect(browser.document.querySelector('[role="alert"]')?.textContent).toContain("cancelled");
    expect(browser.document.querySelector('[role="alert"]')?.textContent).not.toContain("Internal Clerk");
    expect(user.createPasskey).not.toHaveBeenCalled();
    await click("Verify with a passkey"); expect(user.createPasskey).toHaveBeenCalledTimes(1);
  });
});

async function renderPage(content: React.ReactNode) {
  container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<ChakraProvider value={system}>{content}</ChakraProvider>); await browser.happyDOM.waitUntilComplete(); });
  // Dismissal listeners are deferred until after the committed dialog mounts.
  await act(async () => { await browser.happyDOM.waitUntilComplete(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("callback and homepage modal", () => {
  test("every Clerk callback destination retains the intended application destination", async () => {
    const destination = "https://accounts.example.com/oauth-consent?client_id=abc&scope=read";
    navigate(`/sso-callback?${new URLSearchParams({ redirect_url: destination })}`);
    await renderPage(<CallbackPage />);
    for (const prop of ["signInUrl", "signUpUrl", "continueSignUpUrl", "firstFactorUrl", "secondFactorUrl", "resetPasswordUrl", "verifyEmailAddressUrl", "signInForceRedirectUrl", "signUpForceRedirectUrl"]) {
      expect(new URL(callbackProps[prop], "http://localhost:3000").searchParams.get("redirect_url")).toBe(destination);
    }
    expect(new URL(callbackProps.firstFactorUrl, "http://localhost:3000").searchParams.get("auth")).toBe("sign-in");
    expect(new URL(callbackProps.resetPasswordUrl, "http://localhost:3000").searchParams.get("auth")).toBe("forgot-password");
  });

  test("modal dismissal clears only authentication parameters and restores opener focus", async () => {
    await renderPage(<><header><a href="/?auth=sign-up" onClick={(event) => { event.preventDefault(); replace("/?auth=sign-up&redirect_url=%2Finvite%2Ftoken&campaign=launch"); }}>Get started</a></header><AuthModal /></>);
    const opener = browser.document.querySelector("header a") as unknown as HTMLAnchorElement;
    await act(async () => { opener.focus(); opener.click(); await browser.happyDOM.waitUntilComplete(); });
    expect(browser.document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => { (browser.document.querySelector('[aria-label="Close authentication"]') as unknown as HTMLButtonElement).click(); await browser.happyDOM.waitUntilComplete(); });
    expect(navigationUrl.href).toBe("http://localhost:3000/?campaign=launch");
    expect(browser.document.querySelector('[role="dialog"]')).toBeNull();
    expect(browser.document.activeElement).toBe(opener);
  });

  test.each(["Escape", "backdrop"])("%s dismisses the modal and clears its destination", async (action) => {
    navigate("/?auth=sign-in&redirect_url=%2Fprojects%2Fabc&campaign=launch");
    await renderPage(<AuthModal />);
    await act(async () => {
      if (action === "Escape") {
        browser.document.querySelector('[role="dialog"]')!.dispatchEvent(new browser.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } else {
        browser.document.querySelector('[data-scope="dialog"][data-part="backdrop"]')!.dispatchEvent(new browser.window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse", isPrimary: true }));
      }
      await browser.happyDOM.waitUntilComplete();
    });
    expect(navigationUrl.href).toBe("http://localhost:3000/?campaign=launch");
    expect(browser.document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("direct links and navigation changes reopen and close the same modal", async () => {
    navigate("/?auth=forgot-password&redirect_url=%2Fupload%3Fsource%3Dabc");
    await renderPage(<AuthModal />);
    expect(browser.document.body.textContent).toContain("Reset your password");
    await act(async () => navigate("/")); expect(browser.document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => navigate("/?auth=sign-in&redirect_url=%2Fupload%3Fsource%3Dabc"));
    expect(browser.document.body.textContent).toContain("Welcome back");
    expect(browser.document.querySelector('a[href*="forgot-password"]')?.getAttribute("href")).toContain("redirect_url=%2Fupload%3Fsource%3Dabc");
  });
});

describe("marketing account actions", () => {
  const links = () => [...browser.document.querySelectorAll("a")].map((a) => `${a.textContent}|${a.getAttribute("href")}`);
  const page = <><HeaderAccountActions /><StartLink>Start for free</StartLink></>;

  test("signed-out visitors get sign-in and sign-up", async () => {
    user = null;
    await renderPage(page);
    expect(links()).toEqual(["Sign in|/?auth=sign-in", "Get started|/?auth=sign-up", "Start for free|/?auth=sign-up"]);
  });

  test("signed-in visitors go to their workspace and keep the account menu", async () => {
    user = { firstName: "Ada", lastName: "Lovelace", primaryEmailAddress: { emailAddress: "ada@example.test" }, hasImage: false, imageUrl: "" };
    await renderPage(page);
    expect(links()).toEqual(["Go to workspace|/home", "Go to your workspace|/home"]);
    expect(browser.document.querySelector('[aria-label="Account menu"]')?.textContent).toBe("AL");
  });
});
