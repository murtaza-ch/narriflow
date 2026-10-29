# Narriflow for Make

A [Make](https://www.make.com) custom app over the public REST API v1 (`/api/v1`). It
is the app definition in the layout of Make's Apps SDK and its VS Code extension (Make
Apps Editor): a `makecomapp.json` manifest plus one folder per component. It is not a
Bun workspace: the root `bun install`, Turborepo and Biome ignore it, and it has no
build step because Make interprets the files. Users guide:
`apps/web/content/docs/api/make.mdx` (published at `/docs/api/make`).

## What it offers

| Kind | Name | REST calls |
| --- | --- | --- |
| Connection | Workspace API key as a Bearer token, plus a required `Narriflow URL` API origin | `GET /workspace` tests the key and labels the connection with the Workspace name |
| Trigger | Watch events | `GET /events` for the chosen types (`operation.finished`, `finishing.finished`, `autopilot.episode_imported`, `social_post.finished`) |
| Action | Submit a video link | `POST /projects` |
| Action | Generate clips | `POST /projects/{id}/generations` |
| Action | Export a clip | `GET /clips/{id}`, then `POST /clips/{id}/exports` |
| Action | Propose a social post | `POST /social-posts/proposals` |
| Search | Get export download | `GET /exports/{id}/download` (grants expire after 15 minutes) |
| Universal | Make an API call | any path under the connection's host |
| Dropdowns (RPCs) | Brand Profiles, Social Accounts | `GET /brand-profiles`, `GET /social-accounts` |

The Zapier app's six triggers are one module here: pick the event types, then filter in
the scenario (the users guide has the filter for each). Events carry IDs only, and Make
cannot read a project or an operation per event inside a trigger, so the universal
module covers the reads Zapier does in hydrators (for example `GET /operations/{id}` for
an export's ID). It is also a requirement for a public Make app.

`GET /social-accounts` and `POST /social-posts/proposals` come with the Publishing
Queue; `social_post.finished` events need the key's `publishing:read` permission.

## How it works

**The cursor is Make's own.** Make remembers the last item a polling trigger returned
and gives it back as `data.lastId`. The trigger's item ID is the event's `seq`, not its
UUID: the event feed orders by `seq` and reads forward from it, while a UUID has no
order for Make to resume from. Each poll asks
`GET /events?types=…&order=asc&limit=100&after={{data.lastId}}` and pages on with
`nextCursor` until the module's **Limit** is met or no event is newer
(`modules/watch-events`). That never skips an event, however many happen between polls,
which the newest-first read the Zapier app uses cannot promise. Without a stored cursor
(Make's **All**) the feed starts at the oldest event Narriflow keeps, 30 days. The
event's own `id` is in every bundle: map it to a Run key.

**Where to start.** The trigger has an Epoch panel (`watch-events.epoch.iml.json`) so
the first time you add it, **Choose where to start** lists the newest 100 events, read
with `order=desc`, which the API refuses to combine with `after`. The epoch file
therefore overrides the order and turns pagination off. Choosing the newest event starts
from now.

**Idempotency keys come from the module's inputs**, in plain IML with Make's built-in
`sha256()`, so no custom IML function is needed (Make enables those on request only):
`make:<action>:<sha256 of the Run key and every input that shapes the request>`. Nothing
random or time-based is mixed in, so a retry or a replay of an incomplete execution
repeats the request and the API returns the first result (`replayed: true`). Narriflow
never expires a receipt, so identical inputs are the same request forever. Every action
therefore has an optional **Run key**: map the trigger's Event ID to it and each event
runs once while a new event runs again. Export a clip reads the clip's current
`editorRevision` first and puts it in the request and the key, so an edit between two
runs is a new export and a retry is not. `test/validate.test.mjs` fails if an input
reaches a request without reaching its key.

**Errors carry Narriflow's message** (`general/base.iml.json`): status, error code,
message and request ID, and the permission name for a 403 `scope_required`. A 401 is an
`InvalidAccessTokenError`, so Make stops the scenario and asks for a reconnect. A 403 is an
`InvalidConfigurationError`, which also stops it, because a missing permission won't
fix itself on retry. 429 and
5xx keep Make's own `RateLimitError` and `ConnectionError`, which retry later. The
`Authorization` header is sanitized from logs.

**The URL is a connection field.** `Narriflow URL` takes an `https://` origin. Point a
connection at the deployed dev app to test against dev.

## Layout

```
makecomapp.json                  manifest: components, their code files, the Make app to deploy to
general/base.iml.json            base URL, Bearer header, error handling, log sanitization
modules/groups.json              how the modules are grouped in the scenario editor
connections/narriflow/           connection: communication (test call), params, common data (empty)
modules/<name>/<name>.<code>.iml.json
                                 communication, static-params, mappable-params, interface, samples
                                 (and epoch for the trigger)
rpcs/<name>/<name>.<code>.iml.json
                                 communication, params
test/validate.test.mjs           structure checks, no dependencies
```

## Develop

```bash
node --test "integrations/make/test/*.test.mjs"   # Node 22 or newer, no install
```

The tests parse every file, check that the manifest, the files and the groups agree,
that every IML input exists, that no secret is present, and the two decisions above. They
cannot run IML: only Make does. The `Make app` job in `.github/workflows/ci.yml` runs
them on every push and pull request.

## Owner steps: put it in your Make account

These need your Make account, so nobody else can do them for you.

1. In Make, open your profile, **API access**, **Add token** with the scopes
   `sdk-apps:read` and `sdk-apps:write`. Copy the token.
2. In VS Code, install the **Make Apps Editor** extension (publisher Integromat, id
   `Integromat.apps-sdk`) and add your Make environment with that token.
3. Create the empty app: **New app**, app ID `narriflow` (lowercase letters, digits and
   hyphens), version 1, a label such as `Narriflow`, a theme color (a hexadecimal value),
   and set the icon (**Edit icon**: PNG, square, 512 to 2048 px, up to 500 kB).
4. Open `integrations/make` in VS Code. In `makecomapp.json`, replace the placeholder in
   `origins[0]`: `baseUrl` is your zone's API (for example `https://eu1.make.com/api`),
   `appId` is the ID Make assigned, and save the token in `.secrets/apikey` (git-ignored).
5. Right-click `makecomapp.json`, **Deploy to Make (beta)**, pick the origin. Choose
   **Deploy as new remote** (and apply it to all unmapped components). Make creates the
   connection, RPCs and modules, then uploads every code file.
6. Do the first live pass below before you share it.

If the extension does not accept the manifest, create the components in Make's web
editor and paste each file into its tab. `makecomapp.json` is the extension's own file
and Make does not document its schema, so this repo's copy follows the layout the
extension writes when it clones an app and was not deployed from here.

| Web editor | File |
| --- | --- |
| Base | `general/base.iml.json` |
| Connection, Communication and Parameters | `connections/narriflow/narriflow.communication.iml.json`, `…params.iml.json` |
| RPC (`listBrandProfiles`, `listSocialAccounts`), Communication and Parameters | `rpcs/<name>/<name>.communication.iml.json`, `…params.iml.json` |
| Module, Communication, Static parameters, Mappable parameters, Interface, Samples (and Epoch for `watchEvents`) | `modules/<name>/<name>.<tab>.iml.json` |
| Groups | `modules/groups.json` |

Use the module IDs and types from `makecomapp.json`: `watchEvents` is a **Trigger
(polling)**, `getExportDownload` a **Search**, `makeAnApiCall` the **Universal** module,
the rest are **Actions**.

### First live pass

Connect with a Pro or Business Workspace's key, build a scenario with each module, and check:

- The connection test names the Workspace, and a revoked key stops a scenario with a
  reconnect prompt.
- **Watch events**: **Choose where to start** lists recent events, newest first, with no
  error. Choosing the newest event delivers only later ones. Run the scenario twice
  with nothing new and nothing repeats. Create two events and both arrive, oldest
  first, after one poll; set Limit to 1 and they arrive one per run, none lost.
- An action run twice with the same inputs returns the same project, with `replayed`
  true the second time.
- **Export a clip** after editing the clip is a new export.
- Both dropdowns list items, and the Social account one lists active accounts only.
- **Get export download** gives a bundle per ready format.

Anything that does not behave this way is a defect in this definition.

## Sharing

- **Your own organization.** A new app is private to its author until a scenario that
  uses it is saved in an organization, which installs it there for everyone in that
  organization. Nothing else is needed.
- **Other organizations, by invite link.** Open the app and select **Publish**. Make
  generates an invite link that anyone can use to install the app. **Publishing is
  one-way**: a published app cannot be made private or unpublished, and none of its
  modules, connections, RPCs or other components can be deleted afterwards (you can
  hide a module). Remove test modules first, and treat this as a decision, not a trial.
  If you want to undo it, Make's support has to delete the app.
- **Changes go live at once.** Until Make approves an app, an edit takes effect in every
  scenario that uses it. Keep a second, private test app as another entry in
  `origins`, deploy there first, and deploy to the shared app when it passes.

## Later: a public listing

A listing in Make's app directory is a separate, outward-facing step that needs the
owner's approval; the automation map's verdict for Make is to build it by evidence of
demand. Make's current review process (developers.make.com, App review) works like this:

- **Publish first.** The **Review** tab appears only after you publish, which is the
  one-way step above.
- **Code checklist.** All of these are mandatory: sanitized logs and error handling
  in the base and the connection (done), an endpoint of the app's own API in the base
  and the connection (done), correct module labels and descriptions, a universal module
  (done), a correct interface for every module, and a `limit` parameter plus pagination
  in search modules, triggers and RPCs wherever the API supports them. The trigger and
  both RPCs have a limit; Get export download has none yet, and the API does not
  paginate it.
- **Only the credentials the service requires.** The required `Narriflow URL` field selects the API deployment. Before requesting a review, the cutover owner must select the public hostname and decide whether to retain deployment selection or use that origin in the base and connection.
- **Test scenarios.** One scenario that runs every module without errors, plus one that
  produces an error, with execution logs that hold no personal data. Re-run them right
  before the request: log retention is short and the reviewer cannot see old logs.
  Give the reviewers a Workspace on the Pro or Business plan, since the API refuses other plans.
- **Review.** Submit the form (API documentation link and scenario links), then Make's
  automatic review (beta) sends a PDF of issues, then a QA engineer reviews by hand. Each
  fix needs fresh logs.
- **After approval** Make locks the app's common data and publishes the app to every
  Make user, with a development copy only you can see. Later changes are made in that
  copy and go through Make's change approval, and you commit to keeping the app current
  and answering its users.

Decide on OAuth before applying: the REST API accepts Workspace API keys only today.

Narriflow URL is required configuration with no default. Enter the public HTTPS API origin for hosted Make and Zapier connections. The documented placeholder `https://configure-api-origin.invalid` deliberately cannot connect. The development API is `https://narriflowapi-dev.up.railway.app`; for local testing enter `http://localhost:4000`. Existing connections using the web origin must update their Narriflow URL at cutover. Human review and queue links remain on the web origin.
