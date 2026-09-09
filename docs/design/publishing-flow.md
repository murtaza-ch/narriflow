# Publishing drawers

The Clips workspace owns composition. Publish on a clip opens that exact clip; bulk Publish preserves the displayed selection order. Export delivery opens the same composer with its exact export. Calendar’s new-post entry chooses a clip and opens this drawer. The Posts tab (`tab=posts`) manages project history and recovery.

The composer is a right drawer with a fixed header and action footer, a scrolling form, and a compact clip switcher for multiple clips. Desktop account selection sits in a narrow left sidebar beside independent account forms; on mobile it moves above the form. A regeneration card sits above the account forms, with advanced writing options collapsed. Bulk clips use a horizontal thumbnail switcher on desktop. Post history uses compact status rows with icon actions and expandable copy. One eligible account is selected automatically; otherwise the previous eligible selection is restored. Missing connections are explained and account management preserves the local draft. Desktop uses a 900px maximum width; mobile fills the viewport and uses a clip selector.

## Draft and copy ownership

A Publishing Draft belongs to a signed-in actor, workspace, project, clip, and destination account. Browser storage saves text, delivery settings, cover asset identity, and scheduling choices. It never saves credentials or signed media URLs. Studio Device Drafts are independent. Restoration rechecks accounts, covers, exports, schedules, and editor revisions. Missing covers are cleared with an explanation. Admission validates access and exact asset ownership again.

Opening the composer starts a bounded queue of at most two description-generation requests. Requests use the current clip transcript, title, hook, payoff, and Brand Profile voice. A campaign brief is optional. Generated platform copy seeds separate account drafts; edits remain independent. Generation results apply only to the edit version that requested them. An editor revision change preserves text, clears the cover, and requires review. Generation failures and entitlement limits allow manual writing.

Regeneration can replace one account description, the current clip’s descriptions, or the selection. Replacing edited copy explicitly states that scope. Tone, hashtag, CTA, and locked-content guidance remain under collapsed regeneration options.

## Submission

Immediate, single-time, and spread scheduling all submit explicit clip/account items to one durable campaign admission workflow. Each item names the exact export, revision, copy, delivery mode, settings, and cover. Spread previews and admission use the same server calculation, the workspace timezone, and explicit DST overlap resolution. Single-post admission uses the same underlying publication service. Multiple clips may share one account and time; the worker account concurrency limit governs delivery.

The final action confirms the exact submitted content. The actor is frozen with that content. Generated variants are immutable provenance; they have no separate confirmation mutation. Intent identity is stored separately from editable drafts before the request. A lost response or repeated click retries that identity. Terminal partial results retain successful items and retry only corrected failures with a new identity. Admission means queued work, not completed publication; results open in the status drawer.

Exports can be prepared while composing. The drawer shows preparation progress and retry. Submission requires a current compatible export. Review approval, entitlements, account authorization, frozen export ownership, and attempt recovery remain enforced server-side.

## TikTok inbox delivery

`direct` remains the default. `tiktok_inbox` uploads media with the `video.upload` scope to TikTok’s inbox endpoint. Suggested copy stays available to copy, but is never sent as direct-publication metadata. Direct privacy, interaction, title, and cover controls are hidden. A scheduled inbox time is the delivery time.

The `inbox_delivered` state displays **Sent to TikTok**. It settles the delivery attempt and releases its claim without a published event. Automatic polling ends after delivery. Verified later events or explicit status refresh can mark publication; one upload can report multiple deduplicated public videos. Public links require provider post IDs. Late delivery or failure events cannot downgrade established publication evidence.

## Verification

Fast tests cover drawer entry, displayed bulk order, automatic generation, late responses, draft restoration, lost-response retries, independent account admission, timezone/DST handling, and the native inbox upload contract. Disposable-schema gates cover authorization, durable campaign admission, delivery settlement, duplicate/out-of-order webhooks, and multiple reported TikTok posts. Browser verification uses the existing Chrome project and controlled submissions; it does not publish test posts to connected accounts.
