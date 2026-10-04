# Matt Pocock skills v1.3 audit

**Follow-up:** the requested upgrade is now applied. The repository has 37 upstream-managed skills, including 21 from Matt's v1.3.1 release. The audit and unified diff below retain the original installation snapshot; see [Applied upgrade](#applied-upgrade) for the final state.

The largest improvement for your workflow is completing the installed skill dependencies, then using `implement-spec` for substantial Narriflow builds and `retro` after long repair sessions. Your latest 25 sessions mostly concern portfolio work and job applications, so they do not support adopting the whole engineering flow for every request.

Checked on 4 October 2026. The requested comparison uses the immutable `v1.3.0` tag at `984a2c023c9fb42bb6ea40c70a652284a109dc05`. It compares the repository before this audit's edits with every file in the 13 installed Matt skill directories, including references and agent metadata. The working tree was clean when the snapshot was taken.

[The full unified diff](matt-pocock-skills-v1.3.0.diff) records that comparison. Twelve installed skills differ; `implement` matches byte for byte. Much of the patch rewrites punctuation. The functional changes are the glossary convention, explicit loading of dependent skills, routing to new skills, and the invocation policy of `grill-me`.

[v1.3.0](https://github.com/mattpocock/skills/releases/tag/v1.3.0) shipped on 4 October at 17:47 PKT. [v1.3.1](https://github.com/mattpocock/skills/releases/tag/v1.3.1) followed at 17:48 PKT. Prefer v1.3.1 for a later installation. Its only skill-file change relative to v1.3.0 corrects `ask-matt`: after diagnosing a bug, the human can run `retro`; the diagnosing skill no longer automatically hands off to the user-invoked architecture survey. [Exact follow-up diff](https://github.com/mattpocock/skills/compare/v1.3.0...v1.3.1).

| Installed skill | Difference from v1.3.0 before this audit |
| --- | --- |
| `ask-matt` | Routes whole-spec builds to `implement-spec`, PR bodies to `pr`, and close-out to `retro`. Removes the merge-conflict skill route. Glossary rename and prose changes in the router and phase-boundary reference. |
| `code-review` | Quotes the YAML description and tells the human to run setup when its tracker doc is missing. The two review axes and smell baseline remain. |
| `codebase-design` | Glossary references and prose changes across the skill and its two design references. Its module-design principles remain. |
| `domain-modeling` | Uses `GLOSSARY.md` and `GLOSSARY-MAP.md`; renames the format reference to `GLOSSARY-FORMAT.md`. Your installed description already has the broader terminology/ADR trigger. |
| `grill-me` | Replaces the inline interview with an explicit call to `grilling`. Becomes user-invoked and gains Codex metadata disabling implicit invocation. Your installed version can currently be selected automatically. |
| `grill-with-docs` | Explicitly loads `grilling` and `domain-modeling` through separate skill calls. |
| `implement` | No differences. Its current instructions still include committing to the current branch after implementation and review. |
| `improve-codebase-architecture` | Explicitly loads the design, grilling, and domain skills. Glossary rename and report prose changes; the survey/design sequence remains. |
| `prototype` | Prose changes in the skill and its UI/logic references. The underlying prototype workflow remains. |
| `tdd` | Reads the glossary under its new name and explicitly loads `codebase-design` for interface vocabulary. |
| `to-spec` | Quotes the YAML description; directs missing-setup guidance to the human. Prose changes. |
| `to-tickets` | Directs missing-setup guidance to the human. Prose changes; ticket slicing and dependencies remain. |
| `wayfinder` | Explicit skill calls for research, prototype, grilling, and domain work, plus human-directed setup guidance. |

The release adds `implement-spec`, `pr`, and `retro` to Engineering. All three are absent locally. Five other Engineering skills are also absent: `setup-matt-pocock-skills`, `diagnosing-bugs`, `research`, `triage`, and `wizard`. These five are pre-existing gaps, not all new in v1.3. [Engineering inventory](https://github.com/mattpocock/skills/blob/v1.3.0/skills/engineering/README.md).

Outside Engineering, the local install has `grill-me` but lacks the other six Productivity skills: `grilling`, `handoff`, `teach`, `to-questionnaire`, `wait-what`, and `writing-for-agents`. `grilling` is a dependency of installed interview/architecture skills; `writing-for-agents` is needed by `retro`. The `resolving-merge-conflicts` removal needs no local deletion because that skill is not installed. Other providers' skills, including shadcn's `improve`, are outside Matt's release diff.

The rename is complete. `GLOSSARY.md` preserves the former root glossary byte for byte. The format reference was renamed too. References were updated in AGENTS, README, the ADR index, installed skills, the shadcn plan reference, current scratch planning files, and dated architecture reports. This is a naming migration, not a wholesale skill upgrade. No installation metadata or invocation policy was changed.

The setup check found no installed `setup-matt-pocock-skills`, no `docs/agents/issue-tracker.md`, no `docs/agents/domain.md`, and no `Agent skills` configuration block. The repository has a GitHub remote, but actual local planning already lives in `.scratch/<feature>/spec.md` and one file per ticket in `issues/`. A single root glossary and root ADR directory already exist.

I recommend the following setup choices when you install and run [setup](https://github.com/mattpocock/skills/blob/v1.3.0/skills/engineering/setup-matt-pocock-skills/SKILL.md):

- Keep local Markdown as Narriflow's tracker unless you want to move planning to GitHub Issues. Document the existing scratch layout and how to claim, complete, and find unblocked tickets. Existing completed tickets say `**Status:** done`; record that rather than assuming the upstream template's `resolved` convention.
- Keep one `GLOSSARY.md` and `docs/adr/`. Packages alone do not justify splitting a shared domain vocabulary into multiple glossaries.
- Skip triage-label setup while `triage` is uninstalled. If you later use it for incoming reports, configure its label vocabulary then.
- Add pointers to the tracker and domain docs where both Claude Code and Codex will read them. Here, `CLAUDE.md` only imports `AGENTS.md`; putting the shared pointers in AGENTS avoids a Claude-only configuration.

This audit checked setup rather than running its configuration interview. Tracker and documentation choices above are recommendations; no tracker has been switched or scaffolded.

The session sample follows your clarified scope: all projects, Claude Code plus Codex. It contains the latest 25 distinct human sessions by last user/assistant activity in the saved logs, excludes this audit, and excludes native subagents and six Codex CLI runs delegated from a Claude scratchpad. A Claude Desktop worktree chat is retained because its log identifies a human origin. Recency uses message timestamps, not file modification times. Dates below use Asia/Karachi.

The sample contains 17 Claude Code sessions and 8 Codex sessions: 17 portfolio sessions, 4 job-application sessions, and 4 Narriflow sessions. Two of 25 contain explicit Matt skill requests, both in Narriflow. In the remaining 23, the parent logs contain no observed Matt invocation. Skill mentions in inventories, expanded instructions, assistant prose, and transcript search output were not counted as user requests. Expanded skill blocks, Skill tool calls, and calls to read a named SKILL.md count separately as agent access. Claude child logs for the architecture session contain no additional Skill calls; counts below otherwise describe parent logs, not every delegated agent's execution.

| Matt skill observed | Sessions where you explicitly requested it | Sessions with supplied instructions or agent load/read calls |
| --- | ---: | ---: |
| `improve-codebase-architecture` | 1 | 1 |
| `code-review` | 1 | 1 |
| `codebase-design` | 1 | 2 |
| `domain-modeling` | 0 | 1 |

The Claude session `3e64b6db` opens with `/improve-codebase-architecture` and the request to review gaps and inconsistencies. It later loads `codebase-design`. The Codex session `01a10342`, titled "Fix architecture review issues", explicitly attaches `code-review` and `codebase-design` and asks for fixes one by one with review and verification in a loop. Its log contains 10 code-review read calls, 9 codebase-design read calls, 4 domain-modeling read calls, and 10 compaction records. Repeated reads measure context reuse, not 10 separate requests from you.

Primary session evidence: [Claude command invocation](/Users/murtaza/.claude/projects/-Users-murtaza-Documents-dev-narriflow/3e64b6db-0981-4480-bfe1-b1de1b461762.jsonl:3) and [Codex skill attachments](/Users/murtaza/.codex/sessions/2026/10/04/rollout-2026-10-04T00-34-38-01a10342-e735-7300-b1aa-4d965c06f409.jsonl:12).

There are no observed `ask-matt`, `to-spec`, `to-tickets`, `wayfinder`, `grill-me`, `grill-with-docs`, `prototype`, or `tdd` invocations in this particular 25-session sample. This is a short, portfolio-heavy activity sample, not evidence that you never use those skills.

| # | Last activity, PKT | Tool | Project | Session ID | Title | Matt skills observed |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 04 Oct 20:51 | Codex | Narriflow | `01a10702` | Clear local and dev data | None observed |
| 2 | 04 Oct 20:45 | Codex | Job applications | `01a103c8` | Write tailored job applications | None observed |
| 3 | 04 Oct 19:15 | Claude Code | Narriflow | `3e64b6db` | Codebase architecture review | `codebase-design`, `improve-codebase-architecture` |
| 4 | 04 Oct 18:01 | Codex | Job applications | `01a106ff` | Clear data and start fresh | None observed |
| 5 | 04 Oct 15:36 | Claude Code | Narriflow | `7d503463` | Input video sources support | None observed |
| 6 | 04 Oct 15:21 | Claude Code | Portfolio | `9f1ba041` | GPT-6.1 xhigh access | None observed |
| 7 | 04 Oct 14:02 | Codex | Narriflow | `01a10342` | Fix architecture review issues | `code-review`, `codebase-design`, `domain-modeling` |
| 8 | 04 Oct 04:38 | Claude Code | Portfolio | `bc396e27` | Mobile view design and image cropping | None observed |
| 9 | 04 Oct 03:09 | Claude Code | Portfolio | `5c5bcc7d` | Fix hydration mismatch on Sonetra case study | None observed |
| 10 | 04 Oct 02:59 | Codex | Job applications | `01a0f2ef` | Apply to 100 remote jobs | None observed |
| 11 | 04 Oct 02:36 | Claude Code | Portfolio | `f5960382` | Portfolio SEO improvement | None observed |
| 12 | 04 Oct 02:35 | Claude Code | Portfolio | `2a042088` | Analytics integration | None observed |
| 13 | 04 Oct 02:09 | Claude Code | Portfolio | `2b24519f` | Mobile performance and behavior issues | None observed |
| 14 | 04 Oct 01:15 | Codex | Portfolio | `01a1034c` | Remove unused assets and files | None observed |
| 15 | 04 Oct 00:44 | Claude Code | Portfolio | `4b042978` | I want to include the work | None observed |
| 16 | 03 Oct 17:33 | Codex | Portfolio | `01a0fe75` | Create Mifu image assets | None observed |
| 17 | 03 Oct 16:24 | Claude Code | Portfolio | `6ff3949b` | Solareum work page | None observed |
| 18 | 03 Oct 16:11 | Claude Code | Portfolio | `7a849e3a` | Moshpit Studio work experience | None observed |
| 19 | 03 Oct 14:50 | Codex | Job applications | `01a10106` | Apply for full stack developer role | None observed |
| 20 | 03 Oct 03:49 | Claude Code | Portfolio | `0a09e1e0` | Mifu work page | None observed |
| 21 | 03 Oct 03:16 | Claude Code | Portfolio | `96fd4274` | Interactive animated logo | None observed |
| 22 | 03 Oct 02:58 | Claude Code | Portfolio | `842b8e76` | Mifu work page | None observed |
| 23 | 03 Oct 02:51 | Claude Code | Portfolio | `3c1d073f` | Resume cards with Agentic AI animations | None observed |
| 24 | 03 Oct 01:24 | Claude Code | Portfolio | `ce79156e` | Resume cards with Agentic AI animations | None observed |
| 25 | 03 Oct 01:22 | Claude Code | Portfolio | `2d9e865a` | Resume cards with Agentic AI animations | None observed |

My recommendations, in priority order:

1. Complete the install before adding more orchestration. Add `setup-matt-pocock-skills` and `grilling`, then update the existing Matt files together to v1.3.1. Updating `grill-me` alone would replace its working inline interview with a missing dependency. Preserve or deliberately accept its new explicit-only invocation policy. Your checked-in, editable installation and Claude symlinks already serve both tools; keep one install method rather than adding a duplicate Claude plugin. [Installation model](https://github.com/mattpocock/skills/blob/v1.3.0/README.md).

2. Use `implement-spec` when an approved Narriflow effort has several tickets. Your architecture-repair request already asks for many fixes with repeated review, and its 10 compactions show how much work is being kept in one conversation. Turn the approved subset of findings into a spec and dependency-linked tickets, then let independent implementers work from those files and assemble one integration branch. Keep final browser validation and the repository's focused/database gates. A single small fix can continue through `implement`. [implement-spec](https://github.com/mattpocock/skills/blob/v1.3.0/skills/engineering/implement-spec/SKILL.md).

3. Add `retro`, with its `writing-for-agents` dependency, after substantial builds and repairs. Review repeated skill reads, navigation costs, and checks that failed to catch a bug. Reuse the existing Bun checks, hooks, and CI. Mechanical mistakes should become deterministic checks; judgement calls can become review guidance. Run it before discarding context, or point it at the completed session log. [retro](https://github.com/mattpocock/skills/blob/v1.3.0/skills/engineering/retro/SKILL.md).

4. Use `diagnosing-bugs` for difficult regressions such as the portfolio hydration mismatch and mobile performance investigation in this sample. Its first useful deliverable is a reproducible failing command, followed by instrumentation and a regression test. These skills are absent in the Narriflow checkout; install where the work actually happens or use a shared installation if you want them across projects. Routine image swaps and small layout edits do not need an interview/spec/ticket sequence. [diagnosing-bugs](https://github.com/mattpocock/skills/blob/v1.3.0/skills/engineering/diagnosing-bugs/SKILL.md).

5. Add `pr` when you use pull requests as the review artifact. Its before/after evidence and blast-radius discussion fit your repeated requests to verify behavior. Keep the visual proportional to the change. This release's integration-branch workflow does not require a PR for local-ticket work. [pr](https://github.com/mattpocock/skills/blob/v1.3.0/skills/engineering/pr/SKILL.md).

An additional Narriflow-only check, outside the requested 25-session counts, found two September sessions where `grill-with-docs` fell back to `grill-me` because `grilling` was not installed. The publish-drawer session `01a08281` states that substitution explicitly, as does social-accounts session `01a081fe`. This supports fixing the dependency gap first. It does not establish that the dependency gap is the only cause of interview behavior you might dislike.

Keep Narriflow's pre-production compatibility policy above generic ticketing advice. `to-tickets` still describes expand/contract for wide refactors, but the local policy rules out obsolete dual reads/writes and cutover selectors used solely for compatibility. v1.3 does not resolve that local policy difference. `triage` and `wayfinder` are lower priorities for the observed work: the sample has no incoming issue triage or unresolved effort map that would justify adding their process.

Validation: the root glossary content matches its pre-rename Git version byte for byte; non-example relative Markdown links in the changed files resolve; installed Claude skill symlinks remain intact; skill YAML parses; `git diff --check` passes. `bun run lint` passes with six existing warnings and one informational diagnostic outside these edits. No application code changed, so application typechecks, tests, and database gates were not rerun for this documentation migration.


## Applied upgrade

After the audit, you requested the latest versions and the recommended additions. All 28 previously managed entries were reconciled with their current upstream sources. The final installation contains 37 managed skills and the existing custom Claude `codex-delegation` skill. Matt's 21 installed skills match v1.3.1 byte for byte, including their supporting files and invocation metadata.

Added Matt skills: `setup-matt-pocock-skills`, `grilling`, `implement-spec`, `pr`, `retro`, `diagnosing-bugs`, `writing-for-agents`, and `research`. `grilling`, `writing-for-agents`, and `research` complete the interview, retrospection, and wayfinding dependencies recommended above. `grill-me` now uses upstream's explicit-only invocation policy.

Other upstream migrations:

- `documentation-lookup` became `context7-mcp`, from Context7's current `master` branch.
- `next-cache-components` became `next-cache-components-adoption` and `next-cache-components-optimizer`, from `vercel/next.js`'s `canary` branch. Added their recommended `next-dev-loop` workflow too.
- `next-best-practices` was retired upstream in favor of version-matched Next.js documentation. Narriflow already has Next 16.3.3, its bundled `apps/web/node_modules/next/dist/docs/`, and the generated pointer in `apps/web/AGENTS.md`; no application dependency upgrade was required. [Upstream migration guidance](https://github.com/vercel-labs/next-skills).
- Remotion's source path changed to `skills/remotion-best-practices/SKILL.md`. Its latest router includes the supporting reference directories in the same installed bundle.

The source records in `skills-lock.json` now all have a branch, canonical skill path, and current upstream folder hash, including the five older entries that lacked paths. Each skill lives once in `.agents/skills/`, with a Claude symlink pointing there. Added the previously missing Claude links for all three Chakra skills.

Completed the setup recommendations using Narriflow's existing conventions: [local Markdown tracker](../agents/issue-tracker.md), [single glossary and ADR layout](../agents/domain.md), and shared pointers in root `AGENTS.md` (already imported by `CLAUDE.md`). Both existing `done` and `completed` ticket statuses count as closed. Triage remains uninstalled, so no triage configuration was added.

The only local edits to upstream skill content are the two shadcn `improve` references changing `CONTEXT.md` to `GLOSSARY.md`. Their lock hash records the upstream source, as the installer expects. Biome excludes vendored `.agents/skills` examples; application code remains checked. Git attributes preserve upstream Markdown line breaks and example indentation, plus whitespace in the archived upstream patch.

Current source revisions verified on 4 October 2026:

| Source | Installed skills | Branch | Revision |
| --- | ---: | --- | --- |
| `anthropics/skills` | 1 | `main` | [8a1541c4a3ff](https://github.com/anthropics/skills/tree/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4) |
| `chakra-ui/chakra-ui` | 3 | `main` | [961161428b8c](https://github.com/chakra-ui/chakra-ui/tree/961161428b8c59157ad921dd23303b73c294d73f) |
| `clerk/skills` | 4 | `main` | [cc508f98dfca](https://github.com/clerk/skills/tree/cc508f98dfca1ada6b420d2910e6aa150013e80c) |
| `mattpocock/skills` | 21 | `main` | [24fe0ef7737e](https://github.com/mattpocock/skills/tree/24fe0ef7737efae15c87225755e9f6f5965e4888) |
| `neondatabase/agent-skills` | 1 | `main` | [9e4a5705922f](https://github.com/neondatabase/agent-skills/tree/9e4a5705922fddb540c396111a7979e0dca79cc2) |
| `remotion-dev/skills` | 1 | `main` | [0b5db9daae40](https://github.com/remotion-dev/skills/tree/0b5db9daae40f42c73544d1cc0a8c733bd530eaa) |
| `shadcn/improve` | 1 | `main` | [cac56e1ebd3c](https://github.com/shadcn/improve/tree/cac56e1ebd3c279aa9153616cfeac7b174ab90f9) |
| `upstash/context7` | 1 | `master` | [bfa02ea67b57](https://github.com/upstash/context7/tree/bfa02ea67b5707fe0e0a673faa49d0f50b28c80b) |
| `vercel-labs/agent-browser` | 1 | `main` | [526157cfd4ec](https://github.com/vercel-labs/agent-browser/tree/526157cfd4ec64f45939f9ba0f10d5936aa7ac33) |
| `vercel/next.js` | 3 | `canary` | [ba80ee48fc31](https://github.com/vercel/next.js/tree/ba80ee48fc319735151c3ad6d9bb9a8180c9f09e) |

Validation: all 251 downloaded files were checked against their upstream Git blob hashes. Installed file sets and bytes match those snapshots apart from the two documented glossary substitutions. All 37 skill manifests and agent metadata parse, every managed skill is discoverable by both Claude Code and Codex, all symlinks resolve, retired entries are gone, and bundled JavaScript parses. `git diff --check` and `bun run lint` pass; lint retains six unrelated warnings and one informational diagnostic. This upgrade changed skills, configuration, and documentation; application tests and database gates were not rerun. Other application edits happening concurrently in the checkout are outside this upgrade.

Restart Codex to load the newly installed skills into its skill catalog. Repository skill selection is refreshed when starting a new Claude Code session.
