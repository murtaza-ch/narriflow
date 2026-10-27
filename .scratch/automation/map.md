# Automation and integrations map

**Status:** implementation complete on dev (2026-10-24). All 16 implementation tickets are done. Provider credentials, live provider tests, Marketplace submissions, and deployment remain owner rollout steps.

**Tracker:** local Markdown

**Label:** wayfinder:map

**Validated:** 2026-10-24

**Follows:** the External integrations map (2026-10-07, retired 2026-10-27). Its steps 2 to 9 shipped: the usage ledger, the assistant connector, REST v1, Completion Callbacks, and the n8n Drive template. Its remaining verdicts and open questions are carried into the tables below.

## Destination

A Workspace connects a source once. Each new recording becomes branded clips. The right person approves them, they post into open slots on connected accounts, and their view counts come back into Narriflow. Claude, ChatGPT, n8n, Zapier, Make, and scripts can watch and drive every step through the same commands. Approval stays wherever the Brand Profile requires it, and anything that reaches a client or the public without a click runs under authority a person granted, can see, and can revoke.

## Notes

### How this was validated

- A code audit of Autopilot, scheduling, publishing, analytics, review, and the REST and MCP command tables.
- An independent adversarial review (Opus) that rechecked every code claim at its line and attacked the model. It corrected four facts and reshaped two proposals; its findings are folded in below.
- Web research against vendor docs and platform developer docs, recorded in [`../research/ai-automation-market-2026-10.md`](../research/ai-automation-market-2026-10.md).

### What already exists

Narriflow already has every stage of an automated content pipeline. Each stage is a separate feature, and a person connects them by hand.

| Stage | Today | Missing |
| --- | --- | --- |
| Trigger | RSS Autopilot rules; REST and MCP intake; the n8n Drive template | Watched sources other than RSS |
| Settings | A Content Pack per Project; Brand Profiles with template, intro and outro scenes, voice guidance, and approval rule; Workspace and per-user default Brand Profiles | Autopilot rules can't select a Brand Profile at all |
| Clips | Detection, virality scoring, optional auto-render of every detected clip (`packages/services/src/clip.service.ts:2715`) | A rule for which clips to finish without a person |
| Finishing | Campaign Operations: durable, leased, retryable batch actions (`render_selected`, `apply_brand_profile`, `apply_style`, `apply_scene_template`, `apply_motion`, `export_bundle`, `schedule_selected`), assisted copy, thumbnails, dubbing | Nothing starts them when generation ends |
| Approval | Review Rounds with guest access and the Brand Profile approval gate | A person composes and sends every round, by design |
| Scheduling | Bulk scheduling spaces one batch across a posting window in the Workspace time zone; the calendar displays posts | A standing slot plan per account. Two batches for one account can collide |
| Publishing | Durable native publishing to TikTok, YouTube Shorts, Instagram Reels, Facebook Reels, LinkedIn, and X | Nothing |
| Measuring | A `SocialPostMetric` table | Any data in it |
| Watching from outside | Per-request Completion Callbacks. MCP covers Autopilot, review, and publishing. REST covers the Workspace, Brand Profiles, intake, generation, exports, and operations | Any signal for work that no request started, such as an Autopilot episode |

### Verified defects and gaps

Checked at the cited lines on 2026-10-24, including uncommitted edits in the working tree.

- **RSS imports ignore Brand Profiles.** `AutopilotRule.brandTemplateId` (`packages/db/prisma/schema.prisma:1000`) is the only brand field on a rule, and the manual RSS import schema has no `brandProfileId` either (`packages/validators/src/ingest.ts:16`). `importResolvedRssEpisodes` resolves only a Brand Template snapshot (`packages/services/src/project.service.ts:1533`). The approval gate reads a null Brand Profile snapshot as `"none"` (`packages/services/src/review-approval-gate.prisma.ts:59`). Every RSS Project, manual or Autopilot, therefore gets no logo, fonts, scenes, or writing guidance, and a brand that requires client approval doesn't require it for RSS clips. The fix has to define degradation: `resolveForProject` checks the plan and a rollout switch (`packages/services/src/brand-profile.service.ts:566`), so a downgraded Workspace would start failing imports. It must refuse with an actionable reason, never import without an `approval_required` rule.
- **Autopilot breaks silently when its creator leaves.** A rule acts as `createdByUserId` (`packages/services/src/autopilot.service.ts:591`). A removed member fails `requireActor` on every poll (`:593`) until the rule stops after eight failures (`:530`). A hard-deleted user nulls the field (`schema.prisma:1024`). There is no transfer path.
- **Autopilot stops at clips.** A rule imports an episode and starts generation (`autopilot.service.ts:631`). Nothing then exports, writes copy, or prepares a review.
- **Autopilot work is invisible to integrations.** Completion Callbacks attach to a request ([ADR 0013](../../docs/adr/0013-integration-surfaces.md)), and an Autopilot import has none. An n8n flow learns about it only by polling `GET /api/v1/projects`. `WorkflowEvent` can't carry it: its delivery targets are fixed and its rows cascade-delete with the Project (`schema.prisma:724`).
- **No performance data exists.** Every native receipt sets `metrics: null` (nine sites in `packages/services/src/social-publication-native-platforms.ts`, for example `:172`). The manual `recordMetricsForPostId` (`packages/services/src/social.service.ts:330`) has no caller outside a test. No loop polls the platforms, although existing grants already allow a read: YouTube `youtube.readonly`, TikTok `video.list`, Facebook `pages_read_engagement`, and X `tweet.read` (`packages/validators/src/social-provider-capabilities.ts:3`, `:18`, `:13`, `:28`). Instagram insights need another scope and another Meta review. `SocialPostMetric` also cascade-deletes with the Project (`schema.prisma:2428`), so retention expiry would erase the history any learning needs.
- **Scheduling has no memory.** `publishingSlots` computes slots for one batch from a start date, window, and frequency (`packages/services/src/bulk-social-scheduling.ts:297`). `PublicationClaim.accountSlotKey` is a concurrency lock, not a schedule.
- **Dubbing has no spending limit.** It checks only the plan feature (`packages/services/src/dubbing.service.ts:164`). That is tolerable while a person clicks each dub and isn't once anything runs unattended.
- **The content suite still runs inside the 60-second web route** (`apps/web/app/api/[[...route]]/route.ts:1375`, `maxDuration = 60` at `:111`). It blocks automated blog posts, threads, and newsletters. The previous map listed it.
- **Integrations are Business-only** (`packages/services/src/plan-features.ts:83`). The usage ledger that blocked opening them shipped on 2026-10-07. Review rooms and Campaign Operations are gated too: review rooms Business-only (`:94`), Campaign Operations Pro and above (`:73`).

### Market facts

All from vendor and platform docs fetched 2026-10-24 unless dated. Detail and every URL are in the [research note](../research/ai-automation-market-2026-10.md).

- **Nobody ships RSS to published vertical clips end to end.** OpusClip's Auto Import watches only the user's own public YouTube channel, hourly, and stops at clips. Klap's "Post the best clips" filters by virality score and schedules, but only through Zapier or n8n. Narriflow already has both ends, RSS Autopilot and native publishing. Finishing connects them, and that is the clearest gap in the market this scan found. One caveat limits it: most podcast feeds carry audio only, which Narriflow renders as audiograms. So the same finishing has to work for uploads and REST intake too, where video recordings arrive.
- **"Agents" in this market make videos from a brief.** Vizard Agent (2026-08-10), Agent Opus, and Descript's Underlord generate or edit from a prompt. None of their announcements mention scheduling or publishing. A Product Hunt commenter asked Vizard for calendar scheduling.
- **OpusClip is the benchmark.** It has a hosted MCP server with 27 workflow tools and a Claude directory connector. In that connector, post, schedule, cancel, and share return an approval link that a person confirms in OpusClip. It also has a REST API with signed webhooks, a Scheduler API, a Zapier app (one trigger, three actions), and Premiere XML export. All of it is on the $29 Pro plan. Narriflow's connector already follows the same confirm-in-app pattern.
- **API and MCP access is moving down-market.** Reap ($9.99) and Vugola include both on every paid plan, and Descript includes its API on any paid plan. Klap prices its API per operation ($0.32 to $0.48). Narriflow keeps both on Business at $39; Pro is $24 (`packages/validators/src/pricing.ts:83`, `:84`).
- **Workflow-host demand is for AI-generated video with auto-publish.** Those n8n templates have 71k to 215k page views. Clipping templates top out near 3k, and OpusClip's and Vizard's official templates show 0 views. Klap published an official n8n node on 2026-10-08, which had 345 downloads in its first month. Templates are cheap distribution, not a growth engine. AI-short captioning is aimed at the bigger audience.
- **Native "recording ready" triggers are rare.** Zoom, Dropbox, Frame.io V4, Box, Wistia, Mux, Transistor, and Acast send them. Riverside, StreamYard, and Loom don't. Several of these need approval first:
  - Watching a Drive folder needs restricted scopes and a CASA assessment; the Picker with `drive.file` doesn't.
  - Dropbox needs production approval once 50 users link.
  - Zoom needs Marketplace review.
- **Video podcasts are leaving MP4 enclosures.** Apple moved to HLS video on 2026-02-16, and Spotify uses its own Distribution API.
- **Posting limits aren't the bottleneck.**
  - YouTube `videos.insert` now costs 1 unit, in its own bucket of 100 uploads per day (reference updated 2026-10-15).
  - Instagram allows 100 API posts per 24 hours and has no scheduling parameter. Facebook Reels can schedule natively.
  - X charges per call: $0.015 a post, about $0.20 with a link.
  - TikTok is the hard case. It still forces unaudited clients to private. It requires a `creator_info` call before every post, explicit consent, and no default privacy (docs updated 2026-08-04).
- **Reading performance back is feasible.**
  - YouTube: view counts from `videos.list` at 1 unit; retention from the Analytics API, which needs a new `yt-analytics.readonly` grant.
  - Facebook Reels: a retention graph.
  - Instagram: average watch time and skip rate.
  - TikTok: counts only. X: the last 30 days only.
  - Meta keeps renaming and removing metrics (2025-01 and 2025-11-15), so stored metrics need the API version that produced them.
  - No competitor documents a loop from performance back into clipping.
- **Hook testing for Shorts has no platform support.** YouTube's Test & Compare excludes Shorts. Instagram's Trial Reels (`trial_params`, 2025-12-03) show a reel to non-followers first. It was the only native experiment found.
- **MCP Tasks moved into an extension** in the 2026-07-28 spec. Client support isn't confirmed, so vendors expose submit-and-poll tools. `narriflow_get_operation` already works that way.
- **Instagram added an `is_ai_generated` flag** on 2026-06-22. It belongs beside TikTok's disclosure mapping.

## Decisions so far

### Owner direction, 2026-10-24

The owner set aside the launch steps and the persona and asked to implement the whole sequence, including the "by evidence" items. Defaults taken for the open questions, each easy to reverse:

- REST and MCP stay Business-only until the owner decides on Pro.
- A downgraded Workspace's rules keep importing and generating; finishing is skipped and the rule says why.
- Standing grants are built opt-in, Owner or Admin only, with caps and expiry. TikTok is excluded.

Tickets live in [`issues/`](issues/).

### Principles for this cycle

- **Wire existing stages; add concepts only where a stage is missing.** Finishing composes Campaign Operations. Approval keeps Review Rounds and the gate. Publishing keeps Social Posts and Publication Intents.
- **One settings schema before any saved settings.** Finishing settings are one validator schema. A rule stores it, and REST and MCP generation requests may pass it inline. Both are frozen at acceptance. A named, shared Recipe waits until people want to edit one set of settings for many rules or flows, as the previous map required for Presets.
- **Standing authority is one concept.** Sending a Review Round to a client and posting publicly without a click are the same class of action. Both need an explicit grant with an owner, caps, an expiry, a pause, and an audit trail. Neither ships until the owner decides it is a goal.
- **REST never publishes directly.** It may propose posts into the queue. A person, or a standing grant, accepts each one.
- **Public events are a contract; product analytics isn't.** `ProgramAnalyticsEvent` (`schema.prisma:2453`) stays internal, best-effort, and free to change. Workspace Events are versioned, written in the transaction that makes the change, and documented.

### New concepts

**Finishing.** An Autopilot rule gains a Brand Profile and finishing settings, and REST and MCP generation requests may carry the same settings inline, so the n8n Drive flow finishes too. Finishing means: export the top N clips at or above a minimum score in chosen formats, write assisted copy for chosen platforms, then stop at "ready to review" or propose the posts into the Publishing Queue. The finishing step runs as Campaign Operations on the new Project, started by a handoff when the generation run completes. That handoff belongs in `packages/services/src/workflow-run-lifecycle.ts`, a critical path, so it gets its own spec and DB gate. Validation checks the tier when the rule is saved and again when it runs, because a Workspace can downgrade in between. Dubbing stays out of unattended finishing until it has a spending cap.

**Publishing Queue.** Posting slots stored on each Social Account, in the Workspace time zone (for example Monday, Wednesday, and Friday at 09:00). A proposed post is a clip, a finished export variant, and draft copy, held in the existing unused `draft` Social Post status (`schema.prisma:184`). It takes no slot. Accepting it freezes the Publication Intent into the next free slot, meaning no other active Social Post for that account at that time, protected by a unique constraint or a lock on (account, time). TikTok's per-post creator settings still need the person's choices at acceptance (`packages/services/src/social-publication-scheduling.ts:321`). Bulk scheduling becomes "fill the queue," so batches stop colliding. "Accept all" is fine.

**Standing grant.** Exists only if the owner wants unattended delivery (see [Fog](#fog)). A Workspace Owner or Admin grants, per destination, which rule's output may go out, daily and weekly caps, and an expiry after which a person renews it. A destination is a Social Account, or a named list of client reviewers for Review Rounds. Each delivery records the grant revision as its evidence. Any failure or attention outcome pauses the grant. A grant never weakens a Brand Profile's `approval_required` rule; only the existing audited Owner or Admin override can do that (`review-approval-gate.prisma.ts:77`).

**Workspace Event.** An append-only, Workspace-scoped record that carries IDs and an event version, never media URLs. It survives Project deletion and expires after 30 days. The first version covers four types: Autopilot episode imported, generation finished, export finished, and post outcome. Each later feature adds its own types in its own spec, instead of one release instrumenting a dozen critical write sites. Callers read with `GET /api/v1/events?after=<cursor>` and an MCP tool. Zapier and Make polling triggers need exactly this. Push subscriptions come later and reuse the Completion Callback delivery code and signing secret. Per-request Completion Callbacks stay, because n8n's Wait node needs them.

The cursor follows the codebase's existing pattern: the writing transaction increments a per-Workspace counter row as its last statement, as `Project.workflowEventSeq` does (`packages/services/src/ingest-job-lifecycle.ts:147`). The row lock holds until commit, so commit order matches sequence order. Two rejected options: making readers lag is unsafe because admission transactions run up to 20 seconds, and a relay loop would need a lease because local and Railway workers share the database. The counter must not live on the `Workspace` row, which existing `FOR UPDATE` locks already contend for.

This amends ADR 0013, which rejected Workspace-level subscriptions for v1. A pull feed is not a subscription registry, but the ADR and GLOSSARY need the new term and the evidence: Autopilot creates work with no request to attach a callback to.

### Verdicts

| Idea | Verdict | Reason |
| --- | --- | --- |
| RSS Brand Profile fix | Fix now | A brand's approval rule silently doesn't apply to RSS clips. Give rules a `brandProfileId` in the shape finishing will reuse. |
| Autopilot ownership transfer | Fix now | Rules fail without telling anyone when their creator leaves. Pause and notify, and let an Admin take a rule over. |
| Finishing (Autopilot rules and inline on REST and MCP generation) | Build | Autopilot already finds new episodes. Finishing them is what people buy automation for, and video recordings mostly arrive by upload, not RSS. |
| Workspace Event feed | Build, pull only, four types first | Autopilot output is otherwise invisible, and Zapier and Make triggers poll. |
| Performance sync | Build, YouTube and TikTok first, then Facebook | Grants are already held. Without data, no reporting or learning claim is honest. Detach metric history from Project deletion. |
| Publishing Queue | Build | Gives automation a safe place to propose posts and ends batch collisions. |
| REST v1 additions | Build alongside each feature | Autopilot rules, Review Round reads, queue proposals, events. Needs the ADR 0013 amendment. |
| Standing grant (unattended review sends and posts) | Owner decision. Recommend opt-in, with caps, expiry, and TikTok excluded unless its guidelines allow it | Competitors sell auto-posting, but platform policies punish mass posting and a bad post is public. |
| Recipes (named, shared settings) | Later, when people repeat the same settings across rules or flows | Inline settings cover each consumer today. When built, resolve after the replay lookup and store the resolved revision in the result, as Brand Profile defaults do (`project.service.ts:1217`). Putting the revision in the fingerprint would turn honest retries into conflicts. |
| Zapier | Private integration on events and existing commands; public listing after launch | A public listing needs a launched product. |
| n8n | Publish the Drive template; add an Autopilot-to-Slack-or-Drive template on events | Templates are free distribution. A verified node only on evidence. |
| Make | By evidence | Public apps pass QA review and can't be unpublished. |
| Drive Picker and Dropbox Chooser | Build, small | Cheap, and long recordings usually live there. `drive.file` avoids CASA. |
| Zoom cloud recordings | By evidence | Strong trigger for webinar teams, but app review takes an unknown time. |
| AI-short captioning (the previous map's "Finish" pilot) | Pilot after the queue | n8n's biggest video audience assembles AI shorts and needs captions. Needs the no-audio and clip-length fixes from the previous map. |
| Premiere and Resolve timeline export | Build, small | Agencies finish in an editor. Ship before any plugin. |
| Learning from performance | Later | Needs weeks of synced data per Workspace. Start with a "what worked" table. |
| Hook and title variants | Later | Useful only once performance sync can tell variants apart. |
| Library search across transcripts | Later | The RAG note (`.scratch/research/rag-architecture.md`) covers the build. Wait for Workspaces with large back catalogs. |
| Canva app | Later | Inserts finished exports only. |
| In-app chat agent | Don't, this cycle | The MCP connector already puts Narriflow inside Claude and ChatGPT, where people already talk to agents. |
| Visual workflow editor | Don't | Reaffirmed. n8n and Make already are one. |
| Slack app | Don't | Reaffirmed. Templates post to Slack. |
| YouTube channel import | Don't | Reaffirmed. API policy forbids it. |
| ComfyUI finish node | Conditional pilot | Only after Captioned Video has repeat users. Own API key, local ComfyUI only. |
| Premiere or Resolve plugin | Later | Timeline export shipped first; a plugin only on agency demand. |
| TypeScript SDK | Later | OpenAPI plus curl and TypeScript examples first. |
| C2PA signing | Don't, this cycle | Carry AI-disclosure choices to publishing instead. A transformed asset needs its own manifest. |
| ComfyUI highlight or transcript nodes, illustrated explainers, product variations | Don't | Weak fit or a second product. |

### Sequence

1. Owner, in parallel with everything: finish the open launch steps (Claude directory submission, Clerk opaque tokens, the recorded n8n run) and pick the persona. Distribution matters more than more features.
2. Fix RSS Brand Profiles and Autopilot ownership.
3. Workspace Event feed with the four first types, `GET /api/v1/events`, an MCP read tool, and the ADR 0013 and GLOSSARY amendment.
4. Performance sync for YouTube and TikTok, with metric history that survives Project deletion and clip and Workspace performance views. Nothing above blocks it.
5. Finishing up to "ready to review", for Autopilot rules and inline on REST and MCP generation, with its handoff spec and DB gate.
6. Publishing Queue: slots, proposals, acceptance, and REST and MCP proposals. Finishing can then end in the queue.
7. Zapier private integration, the second n8n template, Drive Picker and Dropbox Chooser.
8. By evidence: standing grants, AI-short captioning, timeline export, Zoom, push subscriptions, Make, Recipes, learning, library search.

## Edge cases and limitations

### Money

- Minutes don't bound dubbing, regeneration, or export renders. Unattended finishing excludes dubbing until it has a cap, and export counts per run stay bounded by N.
- Assisted copy uses `gpt-5.4-mini` and costs very little per clip.
- A finishing run refused for quota, capacity, or tier must behave like Autopilot intake today: stop, report why, and retry on the next poll without losing its place.
- Autopilot has no plan gate today. Finishing inherits Campaign Operations' Pro gate, so a Creator Workspace's rules can import but not finish. Say so on the rule.

### Identity and authority

- Every unattended action names the human it acts for. When that person loses access, the rule pauses and someone is told.
- Review Rounds email clients. Brand Profiles have no saved reviewers today (`schema.prisma:1787`); recipients exist only per round. A rule that sends rounds needs a named reviewer list under a standing grant, not a hidden default.
- The MCP review handoff deliberately creates and sends nothing (`packages/mcp-core/src/index.ts:152`). Keep that for assistants.

### Platforms

- TikTok requires the creator's choices on every post, so it stays out of unattended posting even under a standing grant. Proposals to TikTok always end in a person's acceptance.
- YouTube's default of 100 API uploads per project per day covers a queue at today's scale. A quota extension needs a compliance audit, so start the audit before the queue is the main way people post.
- Instagram allows 100 API posts per 24 hours per account. Its API can't schedule, so Narriflow's durable scheduler keeps holding the job.
- X bills per post. Unattended X posts count against the grant's spending cap.
- Metric names change under Meta. Store each snapshot with the API version that produced it, and never compare across a rename.
- Check that RSS ingest handles an HLS video enclosure before promoting Autopilot for video podcasts.
- YouTube's monetization policy excludes mass-produced, templated content (previous map). Caps limit volume; they don't prove originality.

### Events

- Delivery is at least once. Consumers deduplicate by event ID.
- Events carry IDs only. Callers fetch Download Grants separately, as with callbacks.
- With 30-day retention, a poller that is down longer misses events and must re-sync from list endpoints.
- Guest Review decisions have no acting user. Their events need a guest actor kind.

## Fog

- Which persona comes first? Still open from the previous map. It decides whether Zoom (webinar teams), RSS (podcasters), or AI-short captioning (AI-video creators) leads.
- Is unattended delivery, to clients or to the public, a product goal, or does every delivery keep a click?
- Resolved by credit pricing (2026-10-26): Publishing Queue opens at Creator; Finishing, standing grants, Autopilot, REST, MCP, events, and webhooks at Pro; Review Rooms at Business. A rule the plan no longer covers pauses with a reason (`autopilotPlanPauseReason`).
- OAuth consent currently covers every Workspace the user belongs to. Keep that, or store per-client selected-Workspace grants and enforce them on every tool and continuation admission?
- Content Suite generation still runs synchronously inside a 60-second browser route. Make it a durable operation (frozen inputs, per-asset outcomes, Operation Status polling) before exposing it on REST or MCP.
- Generated short video (Vizard-expansion ticket 16, never built; pricing sells only AI images). Build only on demand. Entry gate: the owner names a video provider, model, maximum duration, concurrency, and usage unit; reuse the Generated Media Job contract proven for images and insert results as B-roll or Scene Blocks.
- Unverified:
  - Whether uploads from unverified YouTube API projects are really no longer forced private. The reference changed with no revision note, and nobody has tested it with a real upload.
  - How long TikTok's audit takes.
  - Which grant Facebook Reels insights need beyond `pages_read_engagement`.
  - One user report that claude.ai connectors time out near 240 seconds.
  - Whether Zapier and Make propagate the OAuth `resource` parameter; ChatGPT and Claude file-size limits for app uploads; Gemini and Copilot listing paths.

## Sources

The [research note](../research/ai-automation-market-2026-10.md) lists every URL. The load-bearing ones:

- OpusClip Auto Import: https://help.opus.pro/docs/article/auto-import.md
- OpusClip MCP and Claude connector: https://www.opus.pro/mcp and https://www.opus.pro/blog/claude-video-editing-mcp
- OpusClip pricing: https://www.opus.pro/pricing
- OpusClip Zapier app: https://zapier.com/apps/opusclip/integrations
- Klap API and n8n node: https://docs.klap.app/ and https://www.npmjs.com/package/n8n-nodes-klap
- Descript API and MCP: https://help.descript.com/api-and-mcp/api
- Riverside webhook events: https://docs.riverside.fm/webhooks/event-types.md
- Apple video podcasts (HLS): https://www.apple.com/newsroom/2026/02/apple-introduces-a-new-video-podcast-experience-on-apple-podcasts/
- YouTube quota costs: https://developers.google.com/youtube/v3/determine_quota_cost
- YouTube `videos.insert`: https://developers.google.com/youtube/v3/docs/videos/insert
- YouTube revision history: https://developers.google.com/youtube/v3/revision_history
- YouTube Test & Compare: https://support.google.com/youtube/answer/13861714
- TikTok Content Posting API: https://developers.tiktok.com/doc/content-posting-api-get-started
- TikTok sharing guidelines: https://developers.tiktok.com/doc/content-sharing-guidelines
- Instagram publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing
- Instagram insights: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
- Instagram changelog: https://developers.facebook.com/docs/instagram-platform/changelog
- Facebook Reels publishing: https://developers.facebook.com/docs/video-api/guides/reels-publishing
- X pricing: https://docs.x.com/x-api/getting-started/pricing
- MCP 2026-07-28 changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- n8n community node submission: https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes.md
