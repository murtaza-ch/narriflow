# Assistant directory listing

Materials for the Claude directory submission and the later ChatGPT plugin submission. Submission itself is outward-facing: the owner submits, or explicitly authorizes it at the time. Re-read both requirement pages on the day of submission, because their rules change:

- [Claude connector submission](https://claude.com/docs/connectors/building/submission.md)
- [ChatGPT app submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines)

| Material | Location | State |
| --- | --- | --- |
| Name, descriptions, sample prompts | [copy.md](copy.md) | Drafted |
| ChatGPT positive and negative test cases | [chatgpt-test-cases.md](chatgpt-test-cases.md) | Drafted; needs reviewer-account IDs |
| Claude Apps card screenshots | [screenshots.md](screenshots.md) | Shot list only; capture during live acceptance |
| Icon | `apps/web/app/icon.svg` | Export at the sizes each form requests |
| Public documentation and privacy URLs | `/connector`, `/privacy`, `/terms` | Built |
| Demonstration video | Owner | Record the live acceptance journey |
| Reviewer account | Owner | See below |
| OpenAI verification materials | Owner | As required on the submission page |

## Reviewer account

- A dedicated Business Workspace, comped through Stripe. There is no code path for free Business access.
- Password sign-in with no email-code, magic-link, or device-trust challenge.
- Seed content: one Project created from an uploaded file (not a YouTube link), one Brand Profile set as the Workspace default, generated clips, and one finished export.
- Hand credentials over through the submission form only. Never commit them.

## Gates before submission

- The [live acceptance journey](../../runbooks/mcp-launch-acceptance.md#assistant-connector-launch-2026-10-08) passes on Claude web, Claude Code, ChatGPT developer mode, and Codex desktop, and every public tool has been called on Claude.
- Clerk issues opaque, immediately revocable access tokens whose verification carries the `/mcp` audience.
- The processing usage ledger is accepted.
- Tool annotations match behavior: the six read tools added for launch are read-only, and write tools that reach providers keep `openWorldHint`.
- Access errors name the requirement without upgrade prompts or checkout links.
