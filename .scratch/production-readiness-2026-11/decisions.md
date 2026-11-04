# Owner decisions

1. **Paid owner deletes their account.** Stripe keeps billing because nothing cancels the subscription and nobody else can reach the portal (`packages/auth/src/identity.ts:290`). The runbook says automated repair never cancels. Options: set `cancel_at_period_end` through a durable obligation, or refuse deletion while a subscription is live.
2. **Unsupported import links.** Vimeo, Loom, TikTok, Twitch, X, LinkedIn, Facebook, StreamYard and `drive.google.com` links cannot succeed. Ticket 04 refuses them at intake, so nobody loses credits or time. Building real support for any of them is a separate product decision.
3. **Audio uploads on Free.** The plan comparison says Free has no uploaded assets, but audio has no gate (`packages/services/src/audio-asset.service.ts:225`). Gate it, or correct the comparison row.
4. **Scenes after downgrade.** Motion and Auto Censor are re-checked at export but Scenes are not (`packages/services/src/clip-export.service.ts:118`). Should kept Scenes survive a downgrade?
5. **Content suite cost.** Each call sends up to 48k characters to OpenAI and consumes no credits. Charge for it, or keep the plan gate and rate limit.
6. **Per-chunk source grants.** Every 1 MiB render read re-authorises through the API (`apps/media/python/narriflow_media/source_server.py:146`). Caching grants to expiry looks like the largest render-throughput gain, but overrides the documented "fresh grant per chunk" design.
7. **Enforced CSP.** The app has no enforced content policy and the report-only policy reports nowhere. Enforcing needs a reporting endpoint and the production Clerk host.
8. **Sources real renders still refuse.** Video ending before audio fails with `output_video_duration_mismatch`, and a 500 ms audio timestamp hole fails with `output_audio_timestamps_invalid`. They no longer fail preparation, but each variant now fails after encoding. Repairing them means changing the render graph or contract, which is frozen.
