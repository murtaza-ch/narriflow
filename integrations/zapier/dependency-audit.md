# Zapier dependency audit

Checked 2026-11-01 with Node 24.8.0 and npm 11.6.0. Counts below are affected
packages reported by npm, including parent packages, rather than distinct
advisories. Registry results can change after this date.

| Dependency selection | Production audit | Full audit |
| --- | --- | --- |
| Core and CLI 19.2.1, original lockfile | 2 high | 3 critical, 13 high, 33 moderate, 3 low |
| Core and CLI 19.3.0, committed lockfile | 0 | 3 critical, 10 high, 33 moderate, 3 low |

The supported minor update changes Core, CLI, Schema, `form-data`, `adm-zip`,
and `tmp`. It introduces no application source or interface changes. Zapier
[released 19.3.0 on October 30](https://docs.zapier.com/integrations/news) and
[supports security updates only for its latest packages](https://github.com/zapier/zapier-platform/security).

## Production reachability

`src/index.ts` imports Core, and the application imports no CLI modules.
`npm ls --omit=dev --all --json` confirms that CLI, Yeoman, `simple-git`, `tar`,
`tmp`, `pacote`, and `sigstore` are absent from the production dependency tree.
The CLI's `src/utils/build.js` installs production dependencies for its bundle.

The original production finding was Core's exact `form-data@4.0.5` dependency.
Core 19.3.0 pins `4.0.6`, which fixes the
[multipart field and filename injection advisory](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx).
Narriflow sends JSON requests and does not call Core's multipart uploader, so an
exploit through the current application was not demonstrated. Updating removes
the vulnerable dependency regardless. The final `npm audit --omit=dev --json`
exits successfully with zero findings.

## Remaining upstream CLI blockers

All remaining findings belong to the development dependency tree. They still
matter on developer machines and CI runners. The following constraints prevent
a clean audit through supported dependency resolution:

| Installed path from CLI | Constraint or selected version | Required upstream change |
| --- | --- | --- |
| `yeoman-generator` → `simple-git` → `@simple-git/argv-parser` | Generator 7.5.1 requires `simple-git ^3.20.0`, resolved to 3.36.0 and parser 1.1.1 | Move to patched Git/parser releases outside the allowed major. [Git configuration advisory](https://github.com/advisories/GHSA-x6jw-m9v5-85vh), [editor advisory](https://github.com/advisories/GHSA-v5rq-49vh-5v5c) |
| `yeoman-environment` | CLI pins 4.4.3 | Upgrade to 6.0.1 or later for [generator installation confirmation](https://github.com/advisories/GHSA-vv9j-gjw2-j8wp) |
| Yeoman → `fly-import` → Arborist → `cacache` / `node-gyp` / `pacote` → `tar` | The parents require `tar ^6`, resolved to 6.2.1 | Adopt the patched tar major. Current advisories extend through 7.5.20; [the latest listed fix starts at 7.5.21](https://github.com/advisories/GHSA-r292-9mhp-454m) |
| Yeoman → `fly-import` → Arborist → `pacote` | `^18`, resolved to 18.0.6 | Adopt [pacote 21.5.1 or later](https://github.com/advisories/GHSA-w4pp-8pjf-rmxw) |
| `pacote` → `sigstore` and its verification packages | `sigstore ^2`, resolved to 2.3.1; `@sigstore/core ^1` | Adopt patched verification packages, including [sigstore 4.1.1 or later](https://github.com/advisories/GHSA-52v5-jr5w-gjxr) |
| CLI → `tmp`; CLI → `inquirer` → `external-editor` → `tmp` | CLI pins 0.2.6; external editor requires `^0.0.33` | Adopt [tmp 0.2.7 or later](https://github.com/advisories/GHSA-7c78-jf6q-g5cm) and update the editor dependency |
| CLI's globbing, templates, and scaffolding dependencies | Old `glob`, `minimatch`, and `diff` major ranges | Update their parents to allow patched majors. [Globbing advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249), [diff advisory](https://github.com/advisories/GHSA-73rr-hh4g-fpgx) |

Installed CLI source uses Yeoman in `init` and `pull`; Yeoman supplies Git
helpers and package installation through `fly-import`. These are development
commands, not Narriflow trigger, action, or search execution. This dependency
inspection does not prove every CLI command immune to malicious local project
configuration, environment values, packages, or archives.

Non-force `npm audit fix --package-lock-only --ignore-scripts` and targeted
updates within the declared ranges produced no further lockfile changes.
The audit's proposed CLI downgrade to 19.2.1 does not resolve the known original
findings. No forced downgrade or transitive override was applied. A clean full
audit remains blocked on supported upstream dependency updates.

## Verification

Run from this directory, with the committed lockfile:

```sh
npm ci
npm run typecheck
npm test
npm run validate
npm audit --omit=dev --json
npm audit --json
npm ls --omit=dev --all --json
```

The frozen install, typecheck, all 74 tests, and offline structural validation
passed. The production audit exited 0; the full audit exited 1 with the findings
above. Account-dependent validation and publishing were not run.
