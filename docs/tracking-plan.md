# Tracking plan

The catalog of product analytics events in PostHog. Change this file with the code. [Alerting](runbooks/alerting.md) covers errors and paging.

## Rules

- **Names:** `object_action`, lowercase, present tense, from a fixed verb list. Never put a value in a name: use a property.
- **Facts come from the server, intent from the browser.** Server events cannot be blocked and only exist if the work committed. They use different verbs from browser events, so nothing counts twice.
- **Identity:** `distinct_id` is the Clerk user ID on both sides. Never an email.
- **Properties:** IDs, plan and enums only. Never titles, captions, transcripts or links. Server events read named columns and never row `metadata`.
- **Workspaces:** every forwarded event carries `workspace_id` and `plan_tier`, the Workspace's tier when the event was forwarded. Browser events carry neither; join them through the person. PostHog group analytics is a paid add-on, so it is not used.
- **Person plan:** `plan_tier` on a person changes only on a billing event. Other events fill it in once, for a new person.

## How server events reach PostHog

`packages/services/src/product-events.ts` runs in the hourly cron and forwards the previous hour from the existing ledgers, using each row's ID as the event `uuid`. Events appear up to an hour late. A missed cron run loses that hour, because windows never overlap: a re-sent event could be billed twice. To add an event, map its ledger row in that file.

## Funnel

| Stage | Event | Source |
| --- | --- | --- |
| Acquisition | `user_sign_up` | User |
| | `workspace_create` | Workspace |
| Activation | `import_submit` | Browser |
| | `project_create` (`source_type`) | Project |
| | `import_complete`, `import_partial`, `import_fail`, `import_cancel` | Operation |
| | `clip_generation_complete`, `_partial`, `_fail`, `_cancel` | Operation |
| | `clip_export_create` | Export |
| | `clip_export_complete`, `_partial`, `_fail`, `_cancel` | Operation |
| | `clip_render_complete` | Ledger |
| | `clip_download_start` | Ledger |
| Retention | `social_post_schedule`, `_publish` (`publish_delay_sec`), `_fail` (`error_code`), `_cancel`, all with `platform` | Ledger |
| Referral | `review_send`, `review_open`, `review_changes_request`, `review_item_approve` | Ledger |
| | `campaign_schedule`, `campaign_approve` | Ledger |
| Revenue | `upgrade_prompt_view` (`target_tier`) | Browser |
| | `checkout_start` (`target_tier`, `billing_interval`) | Browser |
| | `subscription_start`, `_upgrade`, `_downgrade`, `_cancel` | Billing |

Feature adoption: `brand_profile_create`, `brand_profile_apply`, `clip_dub_complete`, `social_copy_generate`, `generated_image_complete`.

PostHog also records `$pageview` and autocapture in the browser, with text masked.

## Recommended definitions

These are starting points to confirm against real usage.

- **Activation:** `clip_generation_complete` within 24 hours of `user_sign_up`. It is the first time a person sees the product's value.
- **Retention:** a returning `project_create` within 7 and 30 days of activation. Check for a curve that flattens.
- **North star:** clips exported per active workspace each week (`clip_export_complete`), which sits closest to the value paying customers get.
