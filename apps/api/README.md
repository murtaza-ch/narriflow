# API

## Shared cloud development resources

`bun run dev` loads app-local settings and runs the API in Wrangler. Its development wrapper keeps database URLs out of Worker settings and supplies the direct TLS connection through Hyperdrive's local override. It builds a temporary configuration from `wrangler.jsonc`; configuration and secrets are not copied into a root `.env`.

Workflows and Durable Objects cannot be direct remote bindings in local Wrangler. The local API therefore uses the `DEV_CLOUD` remote Service binding to this dev API's `DevelopmentBindings` entrypoint. That deployed Worker owns scheduler registrations, independent watchdogs, progress sockets, device mailboxes and rate counters. PostgreSQL remains the domain authority. RPC helpers are private JavaScript methods; the exposed methods accept finite transport operations only. No additional public HTTP RPC endpoint or bearer credential is added.

The deployed API must use `APP_ENV=development`. Production rejects this entrypoint. Local and deployed resource settings and signing/encryption keys must match, including `API_ORIGIN`, progress/device keys and the selected database/bucket. A local web app can call its local API while native executors and laptop agents use the canonical public dev API origin.

This follows Cloudflare's [service-binding development pattern](https://developers.cloudflare.com/workers/local-development/#using-remote-resources-with-durable-objects-and-workflows). Use the committed Wrangler configuration for deployment so dashboard-only binding edits do not become the configuration source.
