import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";
let redirects = 0,
	followed = 0;
const fixture = createServer((request, response) => {
	if (request.url === "/redirect") {
		redirects++;
		assert.equal(request.headers.authorization, "Bearer isolated-fixture");
		response.writeHead(302, { location: "/blocked" });
		response.end("redirect body is discarded");
	} else {
		followed++;
		response.writeHead(200, { "content-type": "application/json" });
		response.end("{}");
	}
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const address = fixture.address();
assert(address && typeof address !== "string");
const worker = await unstable_dev(
	fileURLToPath(
		new URL("./gates/social-provider-http-probe.ts", import.meta.url),
	),
	{
		config: fileURLToPath(
			new URL("./gates/wrangler.social-provider-http.jsonc", import.meta.url),
		),
		local: true,
		ip: "127.0.0.1",
		port: 0,
		inspectorPort: 0,
		persist: false,
		logLevel: "error",
		vars: { FIXTURE_PROVIDER_ORIGIN: `http://127.0.0.1:${address.port}` },
		experimental: {
			disableExperimentalWarning: true,
			disableDevRegistry: true,
			watch: false,
		},
	},
);
try {
	const response = await worker.fetch("/");
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { code: "social_provider_redirect" });
	assert.equal(redirects, 1);
	assert.equal(followed, 0);
	console.log(
		JSON.stringify({
			passed: true,
			checks: [
				"actual_workerd_global_fetch_manual",
				"exact_provider_auth_header",
				"single_302_request",
				"no_credential_forwarding",
			],
			redirects,
			followed,
		}),
	);
} finally {
	await worker.stop();
	await new Promise<void>((resolve, reject) =>
		fixture.close((error) => (error ? reject(error) : resolve())),
	);
}
