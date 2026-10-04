# Authentication and automatic Workspace entry

Authentication opens over the homepage at `/?auth=sign-in`, `/?auth=sign-up`, `/?auth=forgot-password`, or `/?auth=continue`. A `redirect_url` parameter carries an intended Project, invitation, Upload Session destination, or approved Clerk OAuth continuation through mode changes and provider callbacks. Credentials and verification codes stay in form state.

Clerk's callback receives explicit entry URLs for first factor, second factor, password reset, and email verification, each preserving the destination. Pending sign-in codes remain valid across refreshes without another email until expiry or an explicit resend. Verification, missing-email completion, and password recovery offer “Use a different email” to restore the form and replace the unfinished attempt. Stored OAuth errors and passkey cancellation use public messages while keeping other methods available.

After Clerk creates an authenticated session, `/auth/continue` admits identity, synchronizes the App User, and ensures a free personal Workspace with its Owner membership, billing account, and first-use brand template. Provisioning does not wait for a webhook. The destination validator defaults to `/home` and rejects external redirects and authentication loops. Failed provisioning shows a retry without losing the destination.

Signed-out protected API requests receive a 401 JSON response without a redirect. Page requests open the homepage modal with their destination.

User deletion atomically clears the unique primary email and AuthIdentity records while retaining the deleted App User and its Workspace. Re-registration creates a separate App User and Workspace. If a deletion webhook was missed, email-conflict recovery releases the old identity only after Clerk confirms a 404; live accounts and Clerk API failures cannot release it. A read-only check of the shared development database on October 4, 2026 found no deleted users holding an email or AuthIdentity, so no fixture cleanup or additional migration was needed.

Clerk owns password verification, CAPTCHA, social authentication, passkeys, and account reverification. Narriflow owns Workspaces and memberships. Clerk Organizations and required organization selection remain disabled. Names and avatars are optional; a nameless user receives “My workspace.” Account settings offer optional passkey creation, listing, renaming, and removal through a custom reverification dialog.

## Development configuration

The shared development Clerk instance is `ins_3A4hVy979RRKVYBzsNcVGZZbu4t` in `app_3A4hVz5AsUDIbRfL5Fg30ql1p9f`. Google, Microsoft, and Apple use Clerk’s shared development credentials. Email is required and verified; usernames and Facebook authentication are disabled. Passkey sign-in and enrollment are enabled. Keep the installed Clerk 6 SDK.

The web app, local environment example, and Vercel `narriflow-dev` project use:

| Setting | Value |
| --- | --- |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/?auth=sign-in` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/?auth=sign-up` |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` | `/auth/continue` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | `/auth/continue` |

Vercel calls the deployed development app’s Git `dev` deployment environment “Production”; it still uses the shared development resources. Environment changes take effect on a new deployment. Migration `20261004040000_automatic_workspace_authentication` has been applied once to the shared `deployed-dev/neondb` database. It removes the onboarding field and replaces the authentication provider enum, deleting only obsolete Facebook authentication identities.

## Verification

Run `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run --cwd apps/web build`. Run `bun run test:authenticated-request-policy:db` and `bun run test:workspace-billing:db` for disposable-schema PostgreSQL checks. The authentication gate also tests first sign-in provisioning before webhook delivery, concurrent creation, nameless profiles, preserved custom Workspace names, retry after an injected database failure, email reuse after deletion, missed deletion webhooks, and refusal to release a live or unverifiable Clerk identity.

The isolated browser form tests exercise email registration and verification, wrong and expired codes followed by retry, password sign-in and reset, all provider callback destinations, OAuth first-factor resumption, stored callback errors, missing-email completion, starting over, pending-code refresh, duplicate submissions, modal dismissal and focus restoration, navigation, passkey sign-in and cancellation, unsupported browsers, enrollment, rename/removal, and custom account-action reverification. Cancellation tests use Clerk's actual error classes. Server contracts cover signed-out API rejection, authenticated entry redirects, request-origin construction, and continuation retry. They mock Clerk resources and the device authenticator; they do not replace live account/device verification.

For live verification, use an account you control to finish each provider’s consent and complete email verification and password recovery. Enroll a passkey from `/settings/profile`, sign out, then use “Sign in with a passkey” on the same origin. A passkey enrolled on localhost cannot verify a Vercel-origin sign-in. Device biometric/PIN prompts and new credential entry require the account holder.
