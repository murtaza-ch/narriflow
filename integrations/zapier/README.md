# Narriflow for Zapier

A [Zapier Platform CLI](https://docs.zapier.com/platform/home) app in TypeScript
over the public REST API v1 (`/api/v1`). It is a standalone npm project, not a
Bun workspace: the root `bun install`, Turborepo and Biome ignore it, and it is
built and tested on its own. Users guide: `apps/web/content/docs/api/zapier.mdx`
(published at `/docs/api/zapier`).

## What it offers

| Kind | Name | REST calls |
| --- | --- | --- |
| Authentication | Workspace API key as a Bearer token, plus a `Narriflow URL` field (default `https://app.narriflow.com`) | `GET /workspace` tests the key and labels the connection with the Workspace name |
| Trigger | Clips Ready | `GET /events` (`operation.finished`, generation `completed` or `partial`), then `GET /projects/{id}` and `GET /projects/{id}/clips` |
| Trigger | Export Finished | `GET /events` (`operation.finished`, export `completed` or `partial`), then `GET /operations/{id}` |
| Trigger | Finishing Ready | `GET /events` (`finishing.finished`, `ready` or `partial`), then `GET /projects/{id}` |
| Trigger | Autopilot Episode Imported | `GET /events` (`autopilot.episode_imported`), then `GET /projects/{id}` |
| Trigger | Post Published | `GET /events` (`social_post.finished`, `posted`), then `GET /clips/{id}` |
| Trigger | Post Needs Attention | `GET /events` (`social_post.finished`, `needs_attention` or `failed`), then `GET /clips/{id}` |
| Action | Submit Video Link | `POST /projects` |
| Action | Generate Clips | `POST /projects/{id}/generations` |
| Action | Export Clip | `GET /clips/{id}`, then `POST /clips/{id}/exports` |
| Action | Propose Social Post | `POST /social-posts/proposals` |
| Search | Find Project | `GET /projects/{id}` or `GET /projects` |
| Search | Get Export Download | `GET /exports/{id}/download` (grants expire after 15 minutes) |
| Dropdowns (hidden triggers) | Brand Profile, Social Account | `GET /brand-profiles`, `GET /social-accounts` |

The reads after `GET /events` run in hydrators, only for events Zapier has not
delivered yet. `GET /events?order=desc` (newest first, without `after`) is what
every trigger polls, so the app needs a deployment that has it.

`GET /social-accounts` and `POST /social-posts/proposals` come with the
Publishing Queue. Against a deployment that predates it, Propose Social Post and
the Social Account dropdown fail with the API's 404.

## How it works

**Polling is one request.** Zapier gives a poll no memory, so each poll asks for
the newest page of the feed: `GET /events?types=…&order=desc&limit=100`
(`src/events.ts`). `order=desc` returns the newest matching events, newest first,
and cannot be combined with `after`. Clips Ready and Export Finished then keep the
generations or exports among the `operation.finished` events they got. However
many events the Workspace has, a poll is that one call. A deployment that predates
`order` would answer oldest first; the app notices and fails the poll with a clear
message instead of serving the oldest events.

**Dedupe is Zapier's.** Every item's `id` is the event ID, which is unique per
terminal transition, so Zapier delivers each event once however many polls return
it. While the Zap editor loads a sample, the poll returns the newest 3 events.

**Hydration is deferred with `z.dehydrate`.** An item carries what the event
already says (IDs, state, export IDs) plus a `details` field that points at a
hydrator (`src/hydrators.ts`, registered under `hydrators` in `src/index.ts`).
Zapier calls the hydrator only for an event it has not delivered, so a poll that
finds nothing new reads nothing but the feed. Each hydrator makes the reads one
event needs (Clips Ready: the project and its top 10 clips; Export Finished: the
operation; Finishing Ready and Autopilot: the project; posts: the clip) and
returns `available: false` for a subject that was deleted, since a dehydrated field
cannot drop its event. Because Zapier nests the result under `details`, mapped
fields show as `Details Project Title` and so on (`details__projectTitle`).

**Idempotency keys come from the step's inputs** (`src/idempotency.ts`):
`zapier:<action>:<sha256 of the canonical JSON of the request>`. Key order,
empty strings and nulls don't matter, and nothing random or time-based is mixed
in, so a Zapier retry or replay repeats the request and the API returns the first
result (`replayed: true`). Narriflow never expires a receipt, so identical inputs
are the same request forever, from any Zap. Every action therefore has an optional
**Run Key**: with one, the digest covers `{ runKey, inputs }`, so mapping the
trigger's Event ID runs each event once and a new event runs again. With an empty
Run Key the key is the inputs-only digest. Export Clip reads the clip's current
`editorRevision` first and puts it in the request and the key, so an edit between
two runs is a new export, and a retry is not. The key never uses `bundle.meta.zap`,
which Zapier has deprecated.

**Errors carry Narriflow's message** (`src/api.ts`). A 401 is Zapier's
`ExpiredAuthError`, so the person is asked to reconnect. A 429 and a 503 are
`ThrottledError`s that wait the API's `retryAfterSeconds` or its `Retry-After`
header. A 403 `scope_required` names the missing permission and where to turn it
on, which is how a key without `publishing:read` surfaces on the two post triggers.
Everything else is a Zapier error with the API's `error` code, `message` and
`requestId`.

**The URL is a connection field.** `Narriflow URL` defaults to production. It
accepts a pasted origin, app URL or API URL, and it must be `https://` except for
`localhost`. Point a connection at the deployed dev app to test against dev.

## Develop

Needs Node 22 or newer.

```bash
cd integrations/zapier
npm install
npm test            # unit tests: Zapier's createAppTester with nock, no network
npm run typecheck
npm run validate    # builds, then runs `zapier-platform validate` offline
```

`npm run validate` passes `--without-style`, which skips the integration checks
that need a Zapier login. Run `npx zapier-platform validate` after `login` to
include them. Tests mock every HTTP call; nothing reaches a real Narriflow or
Zapier.

The root `bun run test` does not run these tests: this folder is outside the Bun
workspaces. The `Zapier app` job in `.github/workflows/ci.yml` runs `npm ci`,
`npm run typecheck`, `npm test` and `npm run validate` here on every push and pull
request. Run the same four commands locally before pushing a change to the app.

`zapier-platform-core` and the CLI are pinned to one exact version, which Zapier
requires. Bump both together, then run the tests and `validate`.

## Owner steps: push it as a private integration

These need your Zapier account, so nobody else can do them for you.

```bash
cd integrations/zapier
npx zapier-platform login                   # a deploy key for your Zapier developer account
npx zapier-platform register "Narriflow"    # creates the integration, writes .zapierapprc (commit it)
npx zapier-platform push                    # runs the TypeScript build, then uploads this version
npx zapier-platform users:links             # shows the invite link to share
npx zapier-platform users:add someone@example.com   # or invite one person by email
```

Bump `version` in `package.json` before every `push`; Zapier keeps each pushed
version. Pushed versions are private: only invited users and you see the app.
Invitees open the link, accept, and connect with a Workspace API key (see the
users guide for the permissions each step needs). To test on dev, invitees set
`Narriflow URL` to the dev deployment.

Do a first live pass before inviting anyone: connect with a Pro or Business Workspace's
key, build a Zap for each trigger and action, and confirm the Zap editor shows
sample data from the trigger tests.

## Later: a public listing

A public directory listing is a separate, outward-facing step that needs the
owner's approval. Zapier's current publishing checklist governs; expect to need:

- Listing details: name, description, category, a logo, and the support and
  documentation URLs (the users guide is the documentation).
- A review account with sample data for Zapier's reviewers, and a Pro or Business plan
  on it, since the API refuses other plans.
- A period of private use first, then `npx zapier-platform promote <version>` and
  Zapier's review. Zapier prefers OAuth for public apps; this app uses an API
  key, so ask what the current review expects for key-based auth.
- Triggers with realistic sample data (they have it) and clear field labels.

Decide on OAuth before applying: the REST API accepts Workspace API keys only
today.
