# Competitive Intelligence: Riverside.fm, Munch, 2short.ai, Zapcap, Quso.ai (ex-Vidyo.ai)

Research date: 2026-07-26. Compiled from official pricing/product pages, help-center docs, and third-party reviews/comparisons. Every claim below is cited inline. Where sources disagreed, both figures are given with the disagreement flagged explicitly — this happened often (pricing figures on aggregator sites, language counts, b-roll availability), so treat single-source numbers as directional, not certain.

---

## Riverside.fm

Important framing: Riverside is fundamentally a **multi-track remote recording studio** (each participant records locally in the browser at up to 4K, uploaded progressively, survives bad internet). AI clipping ("Magic Clips") is a bundled downstream feature on top of the recording product, not the core product — unlike the other four tools in this set, which are clip-generation-first.

### 1. Pricing (2026)
Fetched directly from [riverside.com/pricing](https://riverside.com/pricing) (riverside.fm 301-redirects here):
- **Free**: $0/mo — 2 hours one-off multi-track recording, up to 720p video / 44.1kHz audio, **watermark present**, full editing suite, Magic Clips included, unlimited single-track recording, unlimited video calls.
- **Pro**: $29/mo, or $24/mo billed annually ($288/yr) — 5 hrs/mo of separate-track downloads, up to 4K / 48kHz, **no watermark**, 1 studio, unlimited text-based editing, AI editing & repurposing agent, AI B-Roll, eye-contact correction, silence/filler-word removal, unlimited transcription, Magic Clips & show notes, audio enhancement, podcast hosting & analytics, publishing to YouTube/Spotify/Apple/Instagram/LinkedIn, host teleprompter.
- **Grow** ("Best Value"): $39/mo, or $34/mo annual ($408/yr) — 20 hrs/mo, 2 studios, everything in Pro plus social scheduling, newsletter, creator website, podcast hosting (2 shows), video hosting, AI thumbnails, 1080p live streaming, unlimited multistream destinations, custom RTMP, omnichat, custom overlays/lower-thirds.
- **Webinar**: $99/mo, or $79/mo annual — 25 hrs/mo, 3 studios, everything in Grow plus webinar hosting (100 registrants), recurring webinars, lead capture, branded registration/email, Q&A/polls, HubSpot integration.
- **Business**: custom/contact sales — unlimited recording & studios, up to 10,000 webinar registrants, unlimited storage, SSO (Okta/Azure), SOC2 & ISO27001, API access, dedicated CSM.
- **AI credits**: Pro/Grow include 20 free credits/mo, Business 60/mo, spent on AI Translation, AI B-Roll, and Animated Clips specifically — core Magic Clips/Magic Audio/AI Co-Creator do **not** consume credits ([riverside.com/pricing](https://riverside.com/pricing)).
- Annual billing saves roughly 35% per aggregator summaries ([TrustRadius](https://www.trustradius.com/products/riverside-fm/pricing), [Tekpon](https://tekpon.com/software/riverside-fm/pricing/)); pricing is seat/host-based, guests join free ([JoinSecret](https://www.joinsecret.com/riverside/pricing)).
- **Discrepancy flag**: several aggregators ([Tekpon](https://tekpon.com/software/riverside-fm/pricing/), [ComparEdge](https://comparedge.com/tools/riverside/pricing)) describe an intermediate "**Standard**" plan at $19–24/mo with 15 hrs/mo — this tier does not appear on Riverside's current live pricing page as fetched today. Likely stale/legacy tier naming from before a pricing restructure; treat the direct-site Free/Pro/Grow/Webinar/Business structure as authoritative.

### 2. Processing Speed
Two distinct steps matter here — post-call file finalization, then Magic Clips generation:
- After a call ends, Riverside finalizes the raw recording file in roughly **5–15 minutes for an hour-long episode**, before clip generation can even start ([Podwires PodToolbox](https://podwires.com/podtoolbox/resource/riverside-magic-clips/)).
- Magic Clips generation itself is reported as fast once triggered — "a couple of minutes" / "the AI will take a minute to process the transcript and video" for a one-hour recording ([Feisworld Media](https://www.feisworld.com/blog/riverside-magic-clips); [Podwires](https://podwires.com/podtoolbox/resource/riverside-magic-clips/)).
- Riverside typically surfaces **~2 Magic Clips per 5 minutes of recorded conversation**, each 30–90 seconds long (same sources).
- Marketing copy says clips generate "in seconds" / "one click" but commits to no specific SLA number ([riverside.com/magic-clips](https://riverside.com/magic-clips)).
- No evidence found of streamed/incremental clip output before the (short) processing step completes — clips appear as a batch list. The recording itself is real-time/progressive-upload, which is Riverside's actual "live" characteristic, separate from clip generation.

### 3. Editor / Studio UX
- Hybrid **text-based + timeline editor**: editing the transcript (deleting a word/phrase) removes the corresponding audio/video from the timeline automatically ([Cotovan feature review](https://cotovan.com/post/riverside-features-complete-review-for-podcasters-creators/)).
- **Multi-track**: separate, color-coded tracks per speaker, expandable to individual waveforms ([Cotovan](https://cotovan.com/post/riverside-features-complete-review-for-podcasters-creators/)).
- Documented keyboard shortcuts: Cmd/Ctrl + mouse wheel = zoom timeline; Shift + mouse wheel = scroll timeline sideways; **R** = instantly restore a trimmed region; **Shift+S** = scene cut ([Riverside Help Center — "What's changed in the new editor"](https://support.riverside.com/hc/en-us/articles/35404794986781-What-s-changed-in-the-new-editor); [Cotovan](https://cotovan.com/post/riverside-features-complete-review-for-podcasters-creators/)).
- B-roll accessible via a searchable stock media library plus a direct "Uploads" section for user footage ([Cotovan](https://cotovan.com/post/riverside-features-complete-review-for-podcasters-creators/)).
- A newer **chat-based "AI Co-Creator"** agent lets users edit by conversing with an AI rather than manual timeline work ([Yahoo Finance / Riverside press release](https://finance.yahoo.com/news/riverside-launches-chat-based-editing-140000605.html)).
- Documented limitations from a third-party review: Magic Clips "does not remove silence before generating clips," clip boundaries sometimes land where "the AI thinks a thought ends" rather than the ideal cut point, and users reported "video/audio sync issues in Magic Clips output" ([Blitzcut review, 2026](https://blitzcutai.com/blog/riverside-magic-clips-review-2026)).
- Undo/redo and autosave behavior: not documented in any source checked — **data gap**.

### 4. B-Roll
- Three insertion paths: (a) searchable **stock media library**, (b) user-uploaded footage, (c) **true AI-generated (text/image-to-video) b-roll** ([Cotovan](https://cotovan.com/post/riverside-features-complete-review-for-podcasters-creators/); [Riverside Help Center — "Generate AI B-roll videos"](https://support.riverside.com/hc/en-us/articles/28258467457821-Generate-AI-B-roll-videos)).
- Generative b-roll runs on **Veo3** (text-prompt only, 2 AI credits per generation, ~8 seconds of video) or **Pika** (supports image-to-video, 1 credit per generation) — inserted directly at the editor cursor ([Riverside Help Center](https://support.riverside.com/hc/en-us/articles/28258467457821-Generate-AI-b-roll-videos)).
- This is the **only tool in this set of 5 confirmed to use actual video-generation models** for b-roll rather than stock-footage matching — Munch/2short/Zapcap/Quso all rely on stock libraries (see below). Note the trade-off: generative b-roll costs credits; Munch/2short/Zapcap/Quso stock-based b-roll (where present) does not appear to be metered separately.
- No named traditional stock-provider (Pexels/Storyblocks/Getty/etc.) found attached to the "searchable stock media library" side — data gap.

### 5. Captions
- Marketing claims: "99% accurate" captions, support for "100+ languages," fully customizable font/color/size/placement/movement ([riverside.com/magic-clips](https://riverside.com/magic-clips)).
- **Exact caption preset/style count**: not disclosed on any page found — **data gap** despite checking the marketing page, the Magic Clips glossary entry, and two independent reviews.
- **Discrepancy flag**: a 2026 third-party review of Magic Clips specifically contradicts the marketing claims above, stating captions are effectively "static," with "no word-by-word karaoke style," and that transcription is reliable mainly for "clear English audio" (99%+ accuracy quoted only for English) ([Blitzcut review](https://blitzcutai.com/blog/riverside-magic-clips-review-2026)). This likely reflects a gap between Magic Clips' auto-applied defaults and the fuller caption-preset customization available in Riverside's general editor (which Cotovan's review confirms includes "animated presets" you can design with font/animation/line-count controls: [Cotovan](https://cotovan.com/post/riverside-features-complete-review-for-podcasters-creators/)) — but this is a real, unresolved tension between Riverside's own marketing and an independent tester's experience, not something I could fully reconcile.
- Emoji auto-insertion: not confirmed by any source — **data gap**.
- **Dubbing/translation**: "AI Translation" appears as a named, credit-metered feature in the pricing table ([riverside.com/pricing](https://riverside.com/pricing)), but dedicated feature pages (`/ai-video-translator`, `/ai-dubbing`) both returned 404 when fetched directly, so exact language count and whether it does full audio dubbing (vs. subtitle translation) or voice cloning could not be confirmed — **data gap**.

### 6. Differentiators
- Core marketed identity remains **local multi-track recording quality that survives bad internet** — 4K/48kHz regardless of participants' own hardware/connection, which none of the other four competitors offer (they are all post-hoc clipping tools operating on video you already have).
- Signature line: "Magic Clips is free but feels like a Hollywood-grade producer" ([riverside.com/magic-clips](https://riverside.com/magic-clips)).
- Newest differentiator being pushed: **AI Co-Creator**, chat-based editing agent ([Yahoo Finance](https://finance.yahoo.com/news/riverside-launches-chat-based-editing-140000605.html)).
- Expanding beyond podcasting into **webinars** (dedicated Webinar tier, HubSpot integration, lead capture) and creator "all-in-one" tooling (newsletter, creator website, video hosting) starting at Grow tier ([riverside.com/pricing](https://riverside.com/pricing)).
- Enterprise/trust signals at the Business tier — SOC2, ISO27001, SSO — not matched by any other competitor researched here ([riverside.com/pricing](https://riverside.com/pricing)).

---

## Munch (GetMunch)

**Major caveat discovered during this research**: `getmunch.com` now 301-redirects to `munchstudio.com`. Fetched directly, munchstudio.com's live homepage markets a broad **automated social-media-marketing platform** ("The AI that does your social media marketing for you," "Run your social in 10 minutes a week") with no visible video-clipping-specific pricing table and no mention of "Munch" or "GetMunch" branding anywhere on the page. I could not confirm from public sources whether this is (a) the same company having pivoted/rebranded its whole product, (b) a broader platform that has absorbed video-clipping as one module, or (c) an unrelated entity that now owns the old domain. No dated rebrand announcement was found (unlike Vidyo→Quso, which has an explicit dated rebrand page). **All figures below for "Munch" come from third-party review/aggregator sites describing the classic Munch/GetMunch video-repurposing product — not from a live official page I could independently verify today.** Treat this entire section with more caution than the other four.

### 1. Pricing (2026)
No free tier for uploading your own content was found — the free trial reportedly only works with sample/demo projects; uploading your own video requires a paid plan ([search synthesis](https://sendshort.ai/guides/munch-review/)).
- **Pro**: $49/mo billed annually — monthly minute allowance is reported inconsistently: **200 min** ([ComparaBestAI](https://comparebestai.com/tools/munch-ai), [Sonary](https://sonary.com/b/getmunch/getmunch+creative-tools/)) vs. **250 min** ([ColdIQ](https://coldiq.com/tools/munch)).
- **Elite**: $116/mo annual — **500 min** ([ComparaBestAI](https://comparebestai.com/tools/munch-ai)) vs. **600 min** ([ColdIQ](https://coldiq.com/tools/munch)).
- **Ultimate**: $220/mo annual — **1,000 min** ([ComparaBestAI](https://comparebestai.com/tools/munch-ai)) vs. **1,150 min** ([ColdIQ](https://coldiq.com/tools/munch)).
- **Discrepancy flag**: minute allowances disagree by 20–50 minutes per tier across otherwise-similar review sites — none of these could be checked against a live official pricing page since getmunch.com no longer resolves to one.
- Watermark: paid plans are reported watermark-free ("no watermarks" — [ColdIQ](https://coldiq.com/tools/munch); "all users enjoy premium features like watermark-free exports" — [Sonary](https://sonary.com/b/getmunch/getmunch+creative-tools/)), though the Sonary phrasing doesn't clearly confirm whether any free tier is watermark-free too.
- ColdIQ explicitly flags "pricing only available after signing up, lacks transparency" ([ColdIQ](https://coldiq.com/tools/munch)) — consistent with my own inability to reach a live pricing page.

### 2. Processing Speed
- Reported claims for the same product are internally inconsistent: "4-hour videos processed in just 30 minutes" alongside, from the same synthesis, "a 6-minute video takes just 25 minutes" ([nemovideo.com](https://www.nemovideo.com/blog/what-is-munch-ai-review-2026) / [brandsholder.com](https://brandsholder.com/munch-ai/)) — a 6-minute input taking nearly as long as a 4-hour input strongly suggests large fixed queue/overhead time rather than a clean length-based rule; flagging as a genuine internal oddity.
- One user report: **43 minutes to process a 45-minute YouTube video** ([brandsholder.com](https://brandsholder.com/munch-ai/)).
- **Direct contradiction**: a G2 reviewer quote states "I turned a 45-minute podcast into 5 TikTok clips in **under 10 minutes**" — for a nearly identical video length, this is roughly 4x faster than the 43-minute report above from a different source. This is the sharpest single processing-speed contradiction found across all 5 competitors in this research.
- No evidence of streamed/partial results — users are emailed when the batch job finishes (multiple sources).

### 3. Editor / Studio UX
- Consistently characterized as automation-first with limited manual control: "lacks editing tools for non-basic video editing" ([HitPaw](https://www.hitpaw.com/video-tips/munch-video-editor.html)); "too dependent on automation, limiting manual control" ([ColdIQ](https://coldiq.com/tools/munch)).
- Dashboard has four main actions: **Create Clips, Resize Video, Add Captions, Search Projects**, with a left-hand project/integrations/plan menu ([search synthesis of videosdk.live/precognio.com](https://www.videosdk.live/ai-apps/getmunch)).
- Munch generates a **"coherence score"** per auto-extracted clip — a signal for whether the clip makes sense without surrounding context — a distinctive, not-seen-elsewhere feature ([brandsholder.com](https://brandsholder.com/munch-ai/)).
- A Quso.ai head-to-head comparison page claims Munch supports "scene detection and multi-cam editing" ([quso.ai/alternatives/getmunch-alternative](https://quso.ai/alternatives/getmunch-alternative)) — competitor-published, treat cautiously.
- No documentation found anywhere for keyboard shortcuts, undo/redo, autosave, or multi-select/batch editing — **data gap**.

### 4. B-Roll
This is the most contradicted category found in the entire research task:
- Quso.ai's own head-to-head comparison page explicitly lists "**Stock media/B-roll library**" under a heading titled "Features NOT Available in Munch," alongside also claiming Munch lacks brand kit, virality scoring, and auto-emoji ([quso.ai/alternatives/getmunch-alternative](https://quso.ai/alternatives/getmunch-alternative)) — note this is competitor-published and could be biased or stale.
- An independent review concurs: "No native b-roll insertion or stock footage provider integration mentioned. The tool focuses on extracting clips from uploaded videos and adjusting them for platform requirements." ([Sonary](https://sonary.com/b/getmunch/getmunch+creative-tools/)).
- Yet other sources describe b-roll as an existing Munch editing tool: "Munch offers editing options that include subtitles, B-Rolls, magic posts, auto title, cropping, brand kit, and aspect ratio" (search synthesis) and that the editor "drops extra footage right where stories need a visual boost" ([brandsholder.com](https://brandsholder.com/munch-ai/)-adjacent synthesis).
- **My read**: the more detailed/independent sources (Sonary's dedicated review, and Quso's itemized feature-by-feature comparison) lean toward Munch having weak-to-no native b-roll/stock-library integration, while looser marketing-style summaries assert a basic b-roll toggle exists. No source, on either side, names a specific stock-footage provider (no Pexels/Storyblocks/Getty/Artgrid/Envato ever appears attached to Munch). No AI-generated (video-model) b-roll is claimed by anyone. **Flagging this as unresolved** rather than picking a side.

### 5. Captions
- **Language-count three-way disagreement**: an itemized list of exactly **16 languages** (Chinese, Dutch, English, Finnish, French, German, Hindi, Italian, Japanese, Korean, Polish, Portuguese, Russian, Spanish, Turkish, Ukrainian, Vietnamese) from [quso.ai's comparison page](https://quso.ai/alternatives/getmunch-alternative), vs. "**over 50 languages**" ([HitPaw](https://www.hitpaw.com/video-tips/munch-video-editor.html)), vs. "**over 15 languages**" ([brandsholder.com](https://brandsholder.com/munch-ai/)). The enumerated 16-language list is probably most trustworthy since it names specific languages rather than a round marketing number.
- Caption accuracy reported at "**90% accuracy most times**" ([brandsholder.com](https://brandsholder.com/munch-ai/)/[nemovideo.com](https://www.nemovideo.com/blog/what-is-munch-ai-review-2026)) — notably lower than Zapcap's claimed 99% or industry-standard Whisper-based ~97%.
- No caption style/preset count found anywhere — **data gap**.
- Emoji auto-insertion: Quso's comparison page lists auto-emoji as a Quso advantage in a way that implies Munch lacks it, but this isn't stated as a direct Munch fact independently — **data gap / leans "no."**
- SRT subtitle export is supported ([quso.ai comparison page](https://quso.ai/alternatives/getmunch-alternative)).
- No dedicated translation/dubbing feature was found mentioned anywhere for Munch — likely absent.

### 6. Differentiators
- Tagline: "**The #1 AI Video Repurposing Platform**"; positions itself as a "**viral clip finder**" that watches the entire source video and surfaces the highest-viral-potential moments, "already edited and subtitled" (search synthesis of multiple sources incl. [creati.ai](https://creati.ai/ai-tools/munch/)).
- **Virality score** (out of 100) predicting a clip's viral potential — one source claims this scoring is "ahead of Opus Clip in virality-scoring accuracy," though no methodology or independent benchmark was found to substantiate that specific claim (search synthesis, unverified).
- Distinctive **keyword/trend-research chart**: shows top keywords, search volume, "munched clips," and competition for a given topic (search synthesis).
- Tech stack named explicitly in marketing as GPT + NLP + OCR + computer vision for engagement/virality analysis (search synthesis).
- Founded 2021, HQ Tel Aviv; claims "3,000+ brands and creators" (unsourced marketing figure, search synthesis).
- **Flag again**: given the getmunch.com→munchstudio.com redirect described above, Narriflow should independently re-verify Munch's current live pricing/features directly in-app before relying on any figure in this section for a competitive strategy decision.

---

## 2short.ai

### 1. Pricing (2026)
Fetched directly from [2short.ai/pricing](https://2short.ai/pricing):
- **Starter (Free)**: 30 min/mo of AI video analysis, full feature access, **no watermark** and "unlimited, high-resolution exports" per the official pricing page.
- **Lite**: $9.90/mo — 5 hrs/mo AI analysis, 60 min/mo of "fast server-side exports," Google Drive + URL import, no ads.
- **Pro** (Most Popular): $19.90/mo — 15 hrs/mo AI analysis, **unlimited** fast server-side exports, all Lite features.
- **Premium**: $49.90/mo — 50 hrs/mo AI analysis, unlimited exports, priority support, early beta access.
- No annual pricing is published anywhere — confirmed absent across the official page and three independent reviews ([Creatify](https://creatify.ai/review/2short-ai), [SendShort](https://sendshort.ai/guides/2short-review/)).
- Notably, **no watermark on any tier including free** — this is more generous than every other competitor in this set, all of which watermark their free tier. Also notable: "**Full access to all our features, regardless of your pricing plan**" — tiers gate volume (analysis hours, export minutes), not feature access ([2short.ai homepage](https://2short.ai)).

### 2. Processing Speed
2short.ai is the fastest-processing tool of the 5 by a clear margin, and the most consistently praised for it:
- "A 30-minute YouTube video typically generates clip suggestions within **2–3 minutes**, and the entire process from URL to exportable clips takes **under 10 minutes**" (search synthesis of multiple 2026 reviews).
- Exports specifically: "never took more than **3–10 seconds**" ([Timtis.com user review](https://www.timtis.com/blog/i-tried-letting-ai-turn-my-videos-into-shorts-heres-what-actually-happened-2short-ai-review/)).
- A detailed daily-use review scores overall "**speed score: 9.3/10**" ([ZuloAI](https://www.zuloai.com/blog/using-2shortai-daily-what-works-and-what-doesnt/)).
- Direct quote: "You paste a link. Wait a few minutes. And suddenly you've got multiple clips sitting in front of you." ([Timtis.com](https://www.timtis.com/blog/i-tried-letting-ai-turn-my-videos-into-shorts-heres-what-actually-happened-2short-ai-review/)).
- No evidence of streamed/incremental output — it's a single wait-then-results flow, just a fast one.

### 3. Editor / Studio UX
- Explicitly and consistently **not a full editor** across every source checked: "not a full editing environment," limited to trim/caption-adjust/reframe ([Timtis.com](https://www.timtis.com/blog/i-tried-letting-ai-turn-my-videos-into-shorts-heres-what-actually-happened-2short-ai-review/); [SmartPostly](https://www.smartpostly.com/blogs/2shortai-review-a-fast-repurposing-tool-for-long-videos-but-not-a-full-editing-fix/)).
- One detailed review explicitly enumerates what's **absent**: "no multi-track," "no transitions," "no overlays," "no background audio control," "no sound ducking," "no SFX" ([ZuloAI](https://www.zuloai.com/blog/using-2shortai-daily-what-works-and-what-doesnt/)).
- What the built-in editor **does** offer: fine-trim precision, caption-timing adjustment, font/color changes, transcription-error correction, manual reframing ([ZuloAI](https://www.zuloai.com/blog/using-2shortai-daily-what-works-and-what-doesnt/)).
- **Center-stage facial tracking** automatically keeps the speaker centered when reformatting to vertical 9:16 (search synthesis, multiple sources, confirmed on [2short.ai homepage](https://2short.ai)).
- No keyboard shortcuts, undo/redo, autosave, or multi-select/batch-editing documentation found anywhere — consistent with this being a deliberately minimal, single-purpose editor rather than an omission — **data gap, but likely reflects true absence** given how consistently reviewers describe the tool as narrow-by-design.

### 4. B-Roll
- **Cleanest, least-contradicted finding in this entire research task**: b-roll is confirmed absent by every source checked. "You can't add B-roll, transitions, music, or complex edits within the tool" (search synthesis of multiple 2026 reviews); explicitly "not designed for visual-heavy content" ([ZuloAI](https://www.zuloai.com/blog/using-2shortai-daily-what-works-and-what-doesnt/)); no b-roll capability mentioned in any of the four other reviews fetched ([Creatify](https://creatify.ai/review/2short-ai), [SmartPostly](https://www.smartpostly.com/blogs/2shortai-review-a-fast-repurposing-tool-for-long-videos-but-not-a-full-editing-fix/), [Timtis](https://www.timtis.com/blog/i-tried-letting-ai-turn-my-videos-into-shorts-heres-what-actually-happened-2short-ai-review/)).
- No stock provider, no AI-generated b-roll, no upload-your-own-b-roll capability — the feature category simply does not exist in this product.

### 5. Captions
- Animation styles specifically named: "**bounce, slide, word-highlighting**" ([ZuloAI](https://www.zuloai.com/blog/using-2shortai-daily-what-works-and-what-doesnt/)).
- Caption quality scored "8.6/10" in the same review; noted to struggle with "heavy accents" and "overlapping dialogue."
- Languages: a partial enumerated list appears in one review — "English, French, German, Greek, Hungarian, Indonesian, Italian, Japanese, Korean, Portuguese, Spanish, Swedish, Turkish, Ukrainian, and others" ([Creatify](https://creatify.ai/review/2short-ai)) — no exact total count found anywhere — **data gap**.
- Exact caption style/preset count: only 3 named animation styles found (bounce/slide/word-highlight); no official count disclosed — **data gap**.
- Emoji auto-insertion: not confirmed by any source — **data gap**, likely absent given the minimal-editor positioning.
- No dubbing/translation feature found mentioned anywhere — likely absent, consistent with 2short.ai's narrow "clip finder" scope.

### 6. Differentiators
- Positioned explicitly as "**a clip hunter combined with a caption generator and intelligent auto-cropper**," not a full video editor — a "workflow acceleration" tool rather than a creative suite ([ZuloAI](https://www.zuloai.com/blog/using-2shortai-daily-what-works-and-what-doesnt/)).
- Homepage tagline: "**Elevate your content with AI-generated YouTube Shorts, TikToks and Reels**," promising to "drive views and subscribers **10X faster**" ([2short.ai](https://2short.ai)).
- "Full access to all features regardless of plan" is an explicit pricing-philosophy differentiator vs. feature-gated competitors like Quso/Munch ([2short.ai](https://2short.ai)).
- Best-fit framing across reviews: works best for "**podcasts, interviews, educational videos, and commentary-style formats**" — i.e., spoken-word content, explicitly not visual/b-roll-heavy content (search synthesis).
- **Speed is the single most emphasized differentiator** for this tool across every third-party review found — more consistently praised on this dimension than any other competitor in this set.

---

## Zapcap

### 1. Pricing (2026)
Fetched directly from [zapcap.ai/pricing/](https://zapcap.ai/pricing/):
- **Free**: $0/mo — 3 videos/mo, 1 min 30 sec max duration per video, **no watermark**, no custom templates.
- **Starter**: $8/mo — 15 projects/mo, 2 min max duration, 3 custom templates, no watermark.
- **Pro** (Most Popular): $16/mo — 50 projects/mo, 5 min max duration, 5 custom templates, premium templates, API access (credits sold separately), and **"up to 2x faster" processing** as a named tier benefit.
- **Agency+**: $32/mo — 200 projects/mo, 10 min max duration, 10 custom templates, and **"up to 4x faster" processing**.
- **Enterprise**: custom pricing, invoice billing, negotiable per-video duration.
- Annual billing: "up to 20% off" ([zapcap.ai/pricing/](https://zapcap.ai/pricing/)).
- Separate **usage-based API pricing**: $0.10/min for rendered video, with volume credits and dedicated capacity for scale ([zapcap.ai/api/](https://zapcap.ai/api/)) — positioned explicitly as a cheaper alternative to Submagic's, Shotstack's, and Creatomate's captioning APIs (dedicated comparison landing pages exist for each: [vs. Submagic](https://zapcap.ai/api/alternatives/submagic/), [vs. Shotstack](https://zapcap.ai/api/alternatives/shotstack/), [vs. Creatomate](https://zapcap.ai/blog/zapcap-api-vs-creatomate/)).
- **Discrepancy flag**: one third-party comparison states Zapcap's entry paid tier is "**$10/month**" ([Toolify.ai comparison, via search synthesis](https://www.toolify.ai/ai-news/zapcap-vs-competitors-the-ultimate-ai-video-tool-comparison-3549223)) vs. the official site's **$8/mo** Starter price — minor discrepancy, treat the official $8 figure as authoritative.
- No rollover policy specified anywhere.
- Notably, ZapCap bakes **processing speed itself into the pricing tiers** (2x/4x faster on higher plans) — not seen as an explicit pricing lever for any other competitor researched.

### 2. Processing Speed
- Explicit tiered SLA: Pro = "up to 2x faster," Agency+ = "up to 4x faster" than base ([zapcap.ai/pricing/](https://zapcap.ai/pricing/)) — implying the free/Starter tiers are the slowest baseline.
- General marketing claim: "**ZapCap can process 4K videos in minutes**" (search synthesis).
- Transcription specifically described as happening "**in seconds**" ([zapcap.ai homepage](https://zapcap.ai)).
- No specific "1-hour source video takes X minutes end-to-end" figure was found despite targeted searching — **data gap**.
- No evidence of streamed/partial output before a job completes.

### 3. Editor / Studio UX
- **Important framing correction**: despite this research brief's premise that Zapcap trends toward a "captions-only/lightweight" positioning, Zapcap's current (2026) consumer-facing homepage explicitly markets itself as a **full video editor**, not captions-only — bundling Auto B-Roll, a music/sound-effects library, emoji overlays, filler-word/silence removal, auto-generated descriptions/hashtags, and multi-format trimming (MP4/MOV/MKV, 60+ formats) alongside captions ([zapcap.ai homepage](https://zapcap.ai)).
- The "captions-only/lightweight" characterization is more accurate for Zapcap's **separate developer-facing Captioning API product** (branded "Captioning API — Burn Styled Subtitles Into Video," [zapcap.ai/api/](https://zapcap.ai/api/), docs at [platform.zapcap.ai/docs](https://platform.zapcap.ai/docs/)) — this is a genuinely narrow, single-purpose captions-as-a-service backend aimed at developers, run as a distinct product line from the full dashboard editor.
- A timeline editor exists with font/size/color/position customization (search synthesis), but single- vs. multi-track structure is not documented anywhere found — **data gap**.
- No keyboard-shortcut documentation, no undo/redo documentation, no autosave documentation, no multi-select/batch-editing documentation found anywhere — **data gap** across all sources checked.

### 4. B-Roll
- **"Magic B-Roll"**: one-click AI feature that "analyzes the video's content to match it with appropriate B-roll" and auto-inserts clips from a free stock footage library (search synthesis of [zapcap.ai/features/auto-b-roll/](https://zapcap.ai/features/auto-b-roll/) and related blog content).
- The exact placement mechanism (transcript-semantic/LLM-cued vs. simpler keyword heuristics) is not spelled out in any marketing copy found — **genuine ambiguity, flagged as a gap**.
- No specific stock-footage provider name (Pexels/Storyblocks/etc.) is disclosed anywhere for Zapcap's library — **data gap**.
- No AI-generated (video-model) b-roll is claimed — stock-footage-matching only.
- **Discrepancy flag**: one comparison source (Toolify.ai, could not be directly re-fetched — returned HTTP 403 on a follow-up attempt) states via search synthesis that B-roll/transitions were still "**under development**" as of its writing, which conflicts with ZapCap's own current live claim of a shipped "Auto B-Roll & transitions" feature. Most likely explanation: the comparison piece predates the feature's launch, but this couldn't be confirmed with dates.

### 5. Captions
- **Style-count disagreement even within ZapCap's own materials**: "**26+ subtitle styles**" (general homepage claim) vs. "**21+ customizable templates**" (dedicated [Dynamic Captions feature page](https://zapcap.ai/features/dynamic-captions/)) vs. "**20+ trendy templates**" / "**over 20 trendy templates**" (other marketing copy, search synthesis). Converges roughly around 20–26 styles; treat any single number cautiously.
- Named creator-style caption presets modeled on **Mr. Beast, Alex Hormozi, Ali Abdal** style captions, among others (search synthesis).
- Word-by-word/karaoke-style highlighting confirmed, plus emoji overlays and animated keyword highlighting ([zapcap.ai/features/dynamic-captions/](https://zapcap.ai/features/dynamic-captions/)).
- Accuracy claim: "**99% accuracy**" ([zapcap.ai homepage](https://zapcap.ai)), attributed to using OpenAI's **Whisper** for transcription (search synthesis).
- **Language-count three-way disagreement within Zapcap's own official pages**: "**50+ languages**" ([Dynamic Captions feature page](https://zapcap.ai/features/dynamic-captions/)), "**90+ languages**" (homepage tagline: "Generate accurate video captions with AI in 90+ languages" — [zapcap.ai](https://zapcap.ai)), and "**over 100 languages**" (a comparison piece, search synthesis) — this internal inconsistency is worth flagging prominently, since it's not just cross-site disagreement but disagreement across ZapCap's own pages.
- No dedicated audio-dubbing/voice-translation feature was found — captions/translation appears to be text-only subtitle translation, not full audio dubbing — likely absent, unconfirmed.

### 6. Differentiators
- Homepage tagline: "**Generate accurate video captions with AI in 90+ languages**" ([zapcap.ai](https://zapcap.ai)).
- Heavy, explicit go-to-market focus on being the cheaper/faster **Submagic alternative** — multiple dedicated head-to-head landing pages ([Submagic Free Alternative](https://zapcap.ai/blog/submagic-free-alternative/), [Submagic API Alternative — $0.10/min](https://zapcap.ai/api/alternatives/submagic/)); one comparison piece states Zapcap's entry paid tier is roughly a third of "Submagic's $29/month base plan" (search synthesis).
- Social proof: "**500K active users**," "**700K+ videos created**," "**4.9/5 rating**" ([zapcap.ai homepage](https://zapcap.ai)).
- **Dual go-to-market** — consumer dashboard AND a developer-facing Captioning API sold against Shotstack/Creatomate/Submagic's APIs — a differentiator not found advertised for any of the other 4 competitors in this set (Riverside does have an API, but only at its top custom Business tier, not as a standalone product line).
- Per-tier processing-speed-as-a-pricing-feature (2x/4x faster on higher plans) is unique to Zapcap among the 5 researched.

---

## Quso.ai (formerly Vidyo.ai)

### Rebrand context
Vidyo.ai became **quso.ai** around **December 2024–January 2025** (sources vary on exact month within that window: [SendShort](https://sendshort.ai/news/vidyo-becomes-quso/), [Skywork](https://skywork.ai/skypage/en/Quso.ai-From-Vidyo.ai-to-an-All-in-One-AI-Content-Powerhouse/1972869716755804160)). Same team, login, subscriptions, credits, and projects carried over automatically with no user action required; no pricing changed at the time of rebrand ([quso.ai/vidyo-ai](https://quso.ai/vidyo-ai)). Rationale, in the company's own words: "Vidyo.ai started with one job: turn long videos into short, captioned clips. As it grew into an all-in-one platform for creating, editing, scheduling, and analyzing social content, a clipping-first name no longer fit the product it had become." ([quso.ai/vidyo-ai](https://quso.ai/vidyo-ai)). The rebrand accompanied product expansion into 6–7-platform social scheduling, a content planner, analytics, Brand Kit, and 40+ free AI tools ([quso.ai/vidyo-ai](https://quso.ai/vidyo-ai)). Claims to serve "**4+ million creators**" (same source, unverified marketing figure).

### 1. Pricing (2026)
Fetched directly from [quso.ai/pricing](https://quso.ai) and [quso.ai/faq](https://quso.ai/faq), cross-checked against a 2026 review:
- **Free**: $0/mo — 75 credits/mo, **720p only**, **watermarked**, includes Chapters, short videos, TikTok publishing, CutMagic, 7-day data retention.
- **Lite**: $29/mo, or **$19/mo billed yearly** per direct site fetch — 100 credits/mo (200 on annual); 1080p unlimited, no watermark.
- **Essential**: $39/mo, or **$26/mo billed yearly** — 300 credits/mo (600 annual); adds AI filler/silence removal, content planner.
- **Growth**: $49/mo, or **$33/mo billed yearly** (most popular) — 600 credits/mo (1,200+ annual); adds custom Brand Kit, analytics, priority support.
- **Credit definition (official, consistent across two first-party pages)**: "One credit ≈ one minute of processed video. Clipping, captioning, and editing draw from your monthly credits." ([quso.ai/pricing](https://quso.ai), [quso.ai/faq](https://quso.ai/faq)).
- **Discrepancy flag**: a 2026 review states different annual prices for the same tiers — **$15/$20/$25** per month (annual) for Lite/Essential/Growth ([triedbyhumans.com](https://triedbyhumans.com/tools/quso-ai/review)) vs. the **$19/$26/$33** figures pulled directly from quso.ai today. Treat the direct-site figures as authoritative since they're first-party and current; the review's numbers may be stale or reflect a promo.
- Watermark policy is the one figure with strong 3-source agreement: free tier watermarked, all paid tiers watermark-free ([quso.ai](https://quso.ai), [triedbyhumans.com](https://triedbyhumans.com/tools/quso-ai/review), [Filmora/Wondershare review](https://filmora.wondershare.com/video-editor-review/quso-ai-review.html)).
- No credit-rollover policy is disclosed anywhere, including the official FAQ, which was checked specifically for this ([quso.ai/faq](https://quso.ai/faq)).

### 2. Processing Speed
- AI clip identification + rough cut: **5–10 minutes**; caption styling: **~2 minutes**; full workflow (identification, captioning, branding): **~15 minutes** per recording, claimed to replace "about 2.5 hours" of manual work (search synthesis).
- Full workflow including human review/trim/multi-platform queueing: **under 25 minutes** per recording (search synthesis).
- A 2026 review independently arrives at a very similar figure — "**~25 min full repurposing workflow per recording**" ([triedbyhumans.com](https://triedbyhumans.com/tools/quso-ai/review)) — this is one of the few numeric claims in this entire research task where two independent sources actually agree closely.
- Email notification sent on completion; no evidence anywhere of streamed/partial clip output before the batch finishes.

### 3. Editor / Studio UX
- Word-level, text-based transcript editing confirmed: "**Edit video like a doc** — delete words, remove silences, add B-roll" (search synthesis of quso.ai product pages).
- Voiceover capability mentioned: "**AI-generated or cloned voices**" as part of the editor ([quso.ai/products/ai-video-editor](https://quso.ai/products/ai-video-editor)) — implies some dubbing/voice-cloning exists, though dedicated translation/dubbing landing pages returned 404 on direct fetch, so scope/language-count could not be confirmed — **data gap**.
- Auto scene detection and auto-trimming ([quso.ai/products/ai-video-editor](https://quso.ai/products/ai-video-editor)).
- **Browser-only** — no desktop or official mobile app ([Filmora/Wondershare review](https://filmora.wondershare.com/video-editor-review/quso-ai-review.html)).
- **Max export resolution capped at 1080p even on the top paid tier** — no 4K support at any price ([Filmora/Wondershare review](https://filmora.wondershare.com/video-editor-review/quso-ai-review.html)) — a notable gap vs. Riverside's 4K.
- No documentation found anywhere for keyboard shortcuts, undo/redo, autosave, or multi-select/batch editing, despite checking the dedicated help-center caption-editing article — **data gap**.

### 4. B-Roll
- Stock-footage based, explicitly powered by **Pexels API integration**: "quso.ai's integration with Pexels API provides access to a vast library of unlimited premium videos and images" ([quso.ai/products/b-rolls-library](https://quso.ai/products/b-rolls-library)) — **Pexels is the only specifically-named stock-footage provider found attached to any of the 5 competitors in this entire research task.**
- Placement mechanism: primarily **keyword search** within the library ("search for keywords in quso.ai's B-Rolls library" — [quso.ai/products/b-rolls-library](https://quso.ai/products/b-rolls-library)), marketed as "Add Relevant B-Roll in One Click," though the precise degree of automatic transcript-semantic suggestion (vs. the user manually searching keywords) isn't fully disentangled in the source — **partial data gap**.
- **AI-generated (video-model) b-roll is explicitly NOT yet shipped**: a 2026 review lists "AI-generated B-roll overlays" as "**coming next**" on Quso's roadmap, not currently available ([triedbyhumans.com](https://triedbyhumans.com/tools/quso-ai/review)) — meaning that despite having the strongest named-provider stock integration of the 5, Quso currently lags Riverside specifically on generative b-roll.
- Custom-upload-your-own-b-roll capability: not confirmed or denied anywhere found — **data gap**.

### 5. Captions
- Word-level animated captions with font, size, color, background, animation-style, and layered effects (shadow/outline/blur/padding/border-radius) customization ([Quso Help Center — Change Caption Style, Font & Effects](https://helpdesk.quso.ai/help/editor/change-caption-style-font-effects)).
- Filler-word removal is bundled with captioning ([quso.ai/faq](https://quso.ai/faq)).
- Exact caption preset/style **count**: not disclosed anywhere, including the dedicated help-center article on the subject — **data gap**.
- **Language-count three-way disagreement within Quso's own materials**: "**50+ languages**" ([quso.ai/faq](https://quso.ai/faq): "Captions are available in 50+ languages with word-level timing"), "**100+ languages**" (homepage FAQ section, search synthesis), and "**20+ languages at 85% accuracy**" specifically on the AI-video-editor product page ([quso.ai/products/ai-video-editor](https://quso.ai/products/ai-video-editor)). This is a notable internal inconsistency, structurally similar to Zapcap's own internal language-count spread. The 85%-accuracy figure is also meaningfully lower than the ~99% figures Riverside and Zapcap claim — worth flagging as a possible real quality gap, a stale number, or a differently-scoped claim (e.g., a harder-language subset).
- Emoji auto-insertion: explicitly named as a Quso feature/advantage in its own head-to-head comparison against Munch ([quso.ai/alternatives/getmunch-alternative](https://quso.ai/alternatives/getmunch-alternative)) — reasonably confident this is real since Quso is naming it as a switching incentive for prospective Munch customers.
- Dubbing/translation: "AI-generated or cloned voices" mentioned as an editor capability ([quso.ai/products/ai-video-editor](https://quso.ai/products/ai-video-editor)), but no dedicated dubbing product page could be found/fetched (404s) to confirm language count or exact workflow — **data gap**.

### 6. Differentiators
- Tagline: "**One upload, endless content — clipped, captioned, and ready to post**" ([quso.ai](https://quso.ai)).
- Aggressive, quantified consolidation pitch: replaces "**~$300/month across 6 competitors**" with one $29–49/mo platform ([quso.ai](https://quso.ai)) — methodology behind the "6 competitors / $300" figure is not shown or independently verifiable.
- **Virality scoring** (0–100 scale) named as a Quso-vs-Munch advantage ([quso.ai/alternatives/getmunch-alternative](https://quso.ai/alternatives/getmunch-alternative)).
- "100+ free social media templates" and Brand Kit named as differentiators vs. Munch specifically (same comparison page).
- A 2026 independent review gives a rare, nuanced relative-positioning verdict: Quso trails **Opus Clip** on "AI clip hook detection precision" and trails **Submagic** on "caption aesthetics," but wins on **workflow consolidation**/all-in-one breadth versus both, and is positioned as a "simpler editing interface" alternative to **Klap** ([triedbyhumans.com](https://triedbyhumans.com/tools/quso-ai/review)).
- The rebrand narrative itself doubles as a differentiator/positioning statement: explicitly reframing from "clipping tool" to "all-in-one content operations platform" for creators and small teams ([quso.ai/vidyo-ai](https://quso.ai/vidyo-ai)).

---

## Summary of the sharpest cross-source discrepancies (for quick reference)

| Topic | Competitor | Conflicting figures | Sources |
|---|---|---|---|
| Processing speed for a ~45-min video | Munch | "43 minutes" vs. "under 10 minutes" for near-identical input length | [brandsholder.com](https://brandsholder.com/munch-ai/) vs. G2 reviewer quote (search synthesis) |
| Processing speed, short vs. long video | Munch | 6-min video reported to take ~25 min; 4-hour video reported to take ~30 min | [nemovideo.com](https://www.nemovideo.com/blog/what-is-munch-ai-review-2026) |
| Caption language count | Zapcap | 50+ / 90+ / 100+ languages, all from Zapcap's own materials | [Dynamic Captions page](https://zapcap.ai/features/dynamic-captions/), [homepage](https://zapcap.ai), comparison synthesis |
| Caption language count | Quso.ai | 50+ / 100+ / "20+ at 85% accuracy," all from Quso's own materials | [quso.ai/faq](https://quso.ai/faq), homepage synthesis, [ai-video-editor page](https://quso.ai/products/ai-video-editor) |
| B-roll availability | Munch | Comparison page + independent review say no native b-roll; other marketing summaries say b-roll is a listed editing tool | [quso.ai comparison](https://quso.ai/alternatives/getmunch-alternative), [Sonary](https://sonary.com/b/getmunch/getmunch+creative-tools/) vs. search synthesis |
| Riverside caption quality | Riverside | Marketing: "99% accurate," "100+ languages," animated presets; independent review: "static," English-only, "no karaoke" | [riverside.com/magic-clips](https://riverside.com/magic-clips) vs. [Blitzcut review](https://blitzcutai.com/blog/riverside-magic-clips-review-2026) |
| Munch domain/product identity | Munch | getmunch.com now redirects to munchstudio.com, a seemingly different automated social-marketing product with no visible video-clipping pricing | Direct fetch of [munchstudio.com](https://www.munchstudio.com/) |
| Quso.ai annual pricing | Quso.ai | $19/$26/$33 (direct site) vs. $15/$20/$25 (2026 review) for Lite/Essential/Growth | [quso.ai](https://quso.ai) vs. [triedbyhumans.com](https://triedbyhumans.com/tools/quso-ai/review) |

## Data points not found despite searching (gaps to flag)
- Exact caption **preset/style counts** for Riverside, Munch, 2short.ai, and Quso.ai (only Zapcap has a rough published number, ~20–26, itself inconsistent).
- Riverside's and Quso's dedicated dubbing/translation feature pages both 404'd on direct fetch — language count and audio-dubbing-vs-subtitle-translation scope unconfirmed for both.
- Keyboard shortcuts, undo/redo, and autosave behavior are essentially undocumented in public marketing/help content for Munch, 2short.ai, Zapcap, and Quso.ai (Riverside is the exception, with several shortcuts confirmed via its help center).
- No live, fetchable official pricing page for Munch/GetMunch — the domain now redirects to what appears to be a different product; all Munch pricing in this report is third-party-sourced.
- Zapcap's exact b-roll placement mechanism (LLM/transcript-semantic cueing vs. simpler keyword/heuristic matching) is not disclosed.
- A specific "1-hour source video takes X minutes end-to-end" figure for Zapcap was not found (only relative "2x/4x faster" tier claims and a generic "processes 4K video in minutes" line).
