import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { afterEach, expect, spyOn, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { checkSocialAccountCredential } from "./social-account-credential";
import { SocialOAuthError, socialOAuthService, type PublishSocialAccount } from "./social-oauth.service";

const globals = createDatabaseTestContext();
const previous = globals.client;
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(bindServiceTestEnvironment(globals.bind(() => { globals.client = previous; for (const mock of mocks.splice(0)) mock.mockRestore(); })));

const account = { id: "account", accessToken: "token" } as unknown as PublishSocialAccount;
const withStatus = (status: string) => { globals.client = { socialAccount: { findUnique: async () => ({ status }) } } as unknown as PrismaClient; };
const loads = (result: () => Promise<PublishSocialAccount>) => { const spy = spyOn(socialOAuthService, "getPublishAccount").mockImplementation(result); mocks.push(spy); return spy; };

test("a refreshed, active account is ready and returns the account it loaded", bindServiceTestEnvironment(globals.bind(async () => {
	withStatus("active");
	const spy = loads(async () => account);
	expect(await checkSocialAccountCredential("account")).toEqual({ kind: "ready", account });
	expect(spy).toHaveBeenCalledTimes(1);
})));

for (const code of ["social_account_expired", "social_account_missing", "social_account_refresh_unconfirmed", "social_account_refresh_missing"]) {
	test(`${code} means the person must reconnect`, bindServiceTestEnvironment(globals.bind(async () => {
		withStatus("active");
		loads(async () => { throw new SocialOAuthError(code, "gone", 409); });
		expect(await checkSocialAccountCredential("account")).toEqual({ kind: "reconnect_required" });
	})));
}

test("a refresh already in progress and provider or network failures are not a verdict", bindServiceTestEnvironment(globals.bind(async () => {
	withStatus("active");
	const busy = new SocialOAuthError("social_account_refresh_in_progress", "busy", 503);
	loads(async () => { throw busy; });
	expect(await checkSocialAccountCredential("account")).toEqual({ kind: "temporary", error: busy });
	mocks.pop()!.mockRestore();
	const upstream = new SocialOAuthError("social_oauth_refresh_failed", "provider 502", 502);
	loads(async () => { throw upstream; });
	expect(await checkSocialAccountCredential("account")).toEqual({ kind: "temporary", error: upstream });
	mocks.pop()!.mockRestore();
	const network = new TypeError("fetch failed");
	loads(async () => { throw network; });
	expect(await checkSocialAccountCredential("account")).toEqual({ kind: "temporary", error: network });
})));

test("an account whose status is no longer active needs reconnecting even though its token loads", bindServiceTestEnvironment(globals.bind(async () => {
	withStatus("expired");
	loads(async () => account);
	expect(await checkSocialAccountCredential("account")).toEqual({ kind: "reconnect_required" });
})));
