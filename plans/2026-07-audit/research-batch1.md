# Competitive Intelligence: OpusClip, Vizard.ai, Klap, Submagic (as of 2026-07-26)

Research compiled via web search + fetch of official pricing/docs pages, comparison articles, and G2/review sources. Every claim below is cited inline. Where sources disagreed, both figures are given with a note.

---

## 1. OpusClip

### 1.1 Pricing (2026)

Official pricing page (fetched directly, [opus.pro/pricing](https://www.opus.pro/pricing)):

| Tier | Price | Credits | Notes |
|---|---|---|---|
| Free | $0 | 60 credits/month | Local video up to 10GB/video + YouTube import; export capped at 1080p; exported media "expires after 3 days"; captions ship **with watermark**; clipping is "by spoken words" only (no ClipAnything); no custom fonts, no speaker-based caption colors, no reprompting, no virality scores, most AI editing features locked ([opus.pro/pricing](https://www.opus.pro/pricing)) |
| Starter | $15/mo | 150 credits/month | No watermark, animated captions in 20+ languages, 1 brand template ([opus.pro/pricing](https://www.opus.pro/pricing); [quso.ai/blog/opus-clip-pricing](https://quso.ai/blog/opus-clip-pricing)); AI voice-over capped at "20 per day"; B-Roll capped at "AI image B-Roll (3 clips/month)" and "Stock B-Roll (3 clips/month)" ([opus.pro/pricing](https://www.opus.pro/pricing)) |
| Pro | $29/mo, or $174/yr (≈$14.50/mo effective, billed annually as "3,600 credits annually") | 3,600 credits/year on annual billing | Team workspace with 2 seats, AI B-roll, social scheduler, multiple aspect ratios, export to Adobe/DaVinci ([quso.ai/blog/opus-clip-pricing](https://quso.ai/blog/opus-clip-pricing); [coldiq.com/tools/opus-clip](https://coldiq.com/tools/opus-clip)) |
| Business | Custom / "Contact Sales" | — | Priority support, unlimited users/storage, API integration ([opus.pro/pricing](https://www.opus.pro/pricing)) |

**What a credit buys**: 1 credit = 1 minute of the **uploaded (source) video**, not output. Videos under 1 minute cost a 1-credit minimum; partial minutes round down (a 4.5-minute source clips at 4 credits) ([quso.ai/blog/opus-clip-pricing](https://quso.ai/blog/opus-clip-pricing)). Publishing a finished clip to X/Twitter costs an *additional* 1 credit per post, auto-refunded on post failure ([quso.ai/blog/opus-clip-pricing](https://quso.ai/blog/opus-clip-pricing)).

**Rollover/expiration**: Monthly-plan credits expire after 60 days; annual-plan credits expire after 12 months — they do not roll over indefinitely ([quso.ai/blog/opus-clip-pricing](https://quso.ai/blog/opus-clip-pricing); [eesel.ai/blog/opusclip-pricing](https://www.eesel.ai/blog/opusclip-pricing)).

**Watermark policy**: Free tier ships animated captions "with watermark"; watermark is removed starting at Starter ($15/mo) ([opus.pro/pricing](https://www.opus.pro/pricing)).

**User complaints on billing**: Trustpilot rating 4.0/5 (302 reviews) with 22% 1-star reviews; recurring complaints about processing failures, "hidden credit mechanics," difficulty cancelling, and being "forced into renewal despite unused credits" ([eesel.ai/blog/opusclip-reviews](https://www.eesel.ai/blog/opusclip-reviews)). G2 rating is 4.7/5 across 127 reviews per one source ([g2.com/sellers/opusclip](https://www.g2.com/sellers/opusclip)) vs. 4.6 per a comparison aggregator ([whipscribe.com/tools/clipping](https://whipscribe.com/tools/clipping)) — minor disagreement between sources, both in the 4.6–4.7 range.

### 1.2 Processing Speed

Marketing/user claims are inconsistent but cluster around single-digit minutes for a 1-hour source video:

- OpusClip's own copy: a 60-minute video can be processed into multiple platform-ready clips "within five minutes," with auto-captions rated "97%+ accuracy" ([theplanettools.ai/tools/opusclip](https://theplanettools.ai/tools/opusclip), citing OpusClip marketing).
- OpusClip states its engine now processes a 1-hour video "300% faster than before" (no absolute baseline given) ([opus.pro/blog/opusclip-clip-different](https://www.opus.pro/blog/opusclip-clip-different)).
- A hands-on test: a 59-minute podcast episode was estimated by the UI at 11 minutes but actually finished generating 24 clips in 8 minutes ([bigvu.tv/blog/opus-clips-worth-the-hype](https://bigvu.tv/blog/opus-clips-worth-the-hype)).
- General complaint thread: "slow processing times" cited as a recurring gripe, without quantified figures ([eesel.ai/blog/opusclip-reviews](https://www.eesel.ai/blog/opusclip-reviews)).

**Cross-check verdict**: 2+ independent sources agree on a ~5–11 minute window for a ~1-hour video, consistent with each other.

**Streaming/partial results**: No source confirms OpusClip shows clips before the full video finishes processing — the workflow described everywhere is upload → wait for full processing → receive a batch of ranked clips with Virality Scores ([help.opus.pro/docs/article/9442054-about-the-result-clips](https://help.opus.pro/docs/article/9442054-about-the-result-clips)). No explicit "streaming" or "real-time partial preview" feature was found in official docs or reviews.

### 1.3 Editor / Studio UX

- **Keyboard shortcuts** (documented, [help.opus.pro/docs/article/keyboard-precise-editing](https://help.opus.pro/docs/article/keyboard-precise-editing)): Backspace = quick delete; arrow keys = frame-by-frame move; "D" or "Cmd+B" = split clip; "J" = rewind 2x, "K" = play/pause, "L" = fast-forward 2x; "Ctrl+V" = paste timeline section. A dedicated "Keyboard Shortcuts" changelog entry confirms this shipped as a feature ([opusclip.canny.io/changelog/keyboard-shortcuts](https://opusclip.canny.io/changelog/keyboard-shortcuts)).
- **Undo/redo**: Described by a third party as having "a robust undo/redo system with history tracking" and "non-destructive editing" ([search result, unverified against primary docs]).
- **Autosave**: Projects save to the cloud so "your work stays safe and won't expire" (paid tiers); free-tier exports specifically expire after 3 days ([opus.pro/pricing](https://www.opus.pro/pricing)).
- **Batch/multi-select**: Supports batch downloading of multiple clips and applying saved templates/edits across multiple clips "to scale production" ([opus.pro/blog/how-to-batch-create-a-month-of-clips-in-one-afternoon](https://www.opus.pro/blog/how-to-batch-create-a-month-of-clips-in-one-afternoon)).
- **Preview vs. export fidelity**: No documented systematic mismatch complaints found (unlike Submagic — see below). The dominant UX complaint is qualitative: a "clunky editor" that makes "fixing the AI's mistakes feel like a real chore," with users reporting they spend more time correcting AI picks than they would editing manually from scratch ([sumella.com/how-opusclip-works-and-where-it-still-falls-short](https://sumella.com/how-opusclip-works-and-where-it-still-falls-short/); [eesel.ai/blog/opusclip-reviews](https://www.eesel.ai/blog/opusclip-reviews)). Captions are also reported as "often full of mistakes and a pain to fix," and when source video already has burned-in captions, OpusClip's caption overlay can look messy/duplicated ([eesel.ai/blog/opusclip-reviews](https://www.eesel.ai/blog/opusclip-reviews)).
- Multi-speaker support: split-screen/multi-cam layout works "only when both speakers share the original frame" — i.e., no true independent multi-source split-screen ([whipscribe.com/tools/clipping](https://whipscribe.com/tools/clipping)).

### 1.4 B-Roll

- **Automatic or manual**: Both. One-click "Auto generate B-Roll," or manually select a sentence and generate B-roll for just that sentence, or upload your own footage ([help.opus.pro/docs/article/ai-broll](https://help.opus.pro/docs/article/ai-broll); [opus.pro/ai-b-roll](https://www.opus.pro/ai-b-roll)).
- **Stock provider**: Pexels only, confirmed verbatim from the help doc: "at the moment we just support 'Pexels' for Stock Images. Other providers will be supported in the future" — Storyblocks and Getty Images are named as *planned future* integrations, not currently live ([help.opus.pro/docs/article/ai-broll](https://help.opus.pro/docs/article/ai-broll)).
- **AI-generated b-roll**: Yes — selecting a sentence and choosing "generate B-Roll with AI" produces AI-generated (not stock) footage, though the underlying generation model is not named in any source found ([help.opus.pro/docs/article/ai-broll](https://help.opus.pro/docs/article/ai-broll)).
- **Placement/timing logic**: Described only as "OpusClip AI smartly analyzes your content and adds relevant B-Roll" — contextual analysis, not simple keyword search, but no technical detail on whether it's LLM-cued ([opus.pro/ai-b-roll](https://www.opus.pro/ai-b-roll)).
- **User upload**: Yes, users can upload their own B-roll ([help.opus.pro/docs/article/ai-broll](https://help.opus.pro/docs/article/ai-broll)).
- **Library browser / timeline lane**: A searchable stock library exists (path: "B-Roll" → "Stock Video B-Roll" → keyword search); b-roll clips can be dragged and repositioned directly on the timeline, though no source explicitly describes a dedicated separate "b-roll lane" ([help.opus.pro/docs/article/ai-broll](https://help.opus.pro/docs/article/ai-broll)).

### 1.5 Captions

- **Number of presets**: No exact count found in any source (official or third-party). Blog content groups presets into five *categories* — Bold Statement, Dynamic Word-by-Word, Minimal Clean, Emoji-Enhanced, Branded Custom — but never states a total number of individual templates ([opus.pro/blog/best-caption-presets-styles-boost-retention](https://www.opus.pro/blog/best-caption-presets-styles-boost-retention)). Named presets mentioned elsewhere include "Hormozi Classic," "MrBeast," "Bold Pop," "Neon Glow," "Karaoke," "TikTok Bounce," "Clean Minimal," "Subtitle Bar," "Cinematic," "Pastel Pop" (10 named styles found across search results, likely non-exhaustive) ([search result summary, multiple blog sources]).
- **Animation styles**: Word-by-word "karaoke-style" highlighting is the flagship style, syncing color/highlight changes to speech cadence; caption display duration is adjustable 1–8 seconds with fade transitions ([opus.pro/blog/best-caption-presets-styles-boost-retention](https://www.opus.pro/blog/best-caption-presets-styles-boost-retention)).
- **Emoji auto-insertion**: Confirmed — the free tier explicitly lists "AI captions emoji" ([coldiq.com/tools/opus-clip](https://coldiq.com/tools/opus-clip)), and a blog post claims "strategic emoji integration... can boost retention by 15–25% for entertainment/lifestyle content," recommending "one emoji per caption line maximum" ([opus.pro/blog/best-caption-presets-styles-boost-retention](https://www.opus.pro/blog/best-caption-presets-styles-boost-retention)).
- **Multi-language**: Officially "20+ languages" for captions, with named languages including English, German, Spanish, French, Portuguese, Italian, Dutch, Russian, Polish, Indonesian, Ukrainian, Swedish, Turkish, Norwegian, Croatian, Romanian, Slovak, Greek, Danish, Finnish ([opus.pro/captions](https://www.opus.pro/captions)). One third-party source separately cites "30+ other languages" for translation ([whipscribe/other summary]) — treat 20+ as the primary-source figure.
- **Translation/dubbing**: Subtitle translator converts captions into 20+ languages ([opus.pro/tools/subtitle-translator](https://www.opus.pro/tools/subtitle-translator)); a single job can render captions in multiple target languages simultaneously, one output file per language ([search result synthesis]). **No full audio-dubbing product was confirmed** for OpusClip in any source checked — this looks like caption/subtitle translation only, not voice dubbing (contrast with Klap and Submagic, both of which have named dubbing/audio-translation features below).

### 1.6 Differentiators

- **"ClipAnything"**: OpusClip's flagship, marketed as "the first-ever multimodal AI clipping that lets you clip any moment from ANY video using visual, audio, and sentiment cues, including videos with little to no dialogue" ([opus.pro/clipanything](https://www.opus.pro/clipanything)). Positioned explicitly against older tools that "only worked well with simple talking-head videos" — targets vlogs, gaming streams, multi-person interviews by analyzing "visual cues, audio sentiment, facial expressions, and emotional peaks" simultaneously ([futurepedia.io/courses/opus-clip-ai/lessons/virality-score](https://www.futurepedia.io/courses/opus-clip-ai/lessons/virality-score)).
- **"Virality Score"**: Every clip scored 1–100 on dimensions including Hook, Flow, Engagement, and Trend, drawing on "thousands of data points" around hooks/retention cues/trends ([futurepedia.io/courses/opus-clip-ai/lessons/virality-score](https://www.futurepedia.io/courses/opus-clip-ai/lessons/virality-score)). Caveat found in reviews: "the score isn't always a great predictor... a clip with a low score blows up while a high-scoring one gets no traction," and OpusClip does not publish a technical validation study for the scoring ([search synthesis]).
- **Homepage headline**: "1 long video, 10 viral clips," self-styled "#1 AI video clipping tool to create viral shorts" ([opus.pro/home-a-b](https://www.opus.pro/home-a-b)); another framing: "OpusClip turns long videos into viral clips fast with AI clipping, captioning, and publishing" ([coldiq.com/tools/opus-clip](https://coldiq.com/tools/opus-clip)).
- **Scale claim**: Largest user base among the four per a comparison aggregator, "10M Users" cited in a review title ([theplanettools.ai/tools/opusclip](https://theplanettools.ai/tools/opusclip)); positioned by whipscribe.com as having "Largest user base. Best-in-class virality scoring + ClipAnything search" ([whipscribe.com/tools/clipping](https://whipscribe.com/tools/clipping)).
- **Head-to-head framing found**: Klap markets AI dubbing (29 languages) as a capability "OpusClip lacks... entirely" ([search synthesis citing a Klap-vs-Opus comparison]).

---

## 2. Vizard.ai

### 2.1 Pricing (2026)

Official docs confirm the credit system and caps ([docs.vizard.ai/docs/pricing](https://docs.vizard.ai/docs/pricing)); tier pricing cross-checked via [vizard.ai/pricing](https://vizard.ai/pricing) (fetched directly) and third-party trackers:

| Tier | Monthly | Annual (effective monthly) | Credits | Notes |
|---|---|---|---|---|
| Free | $0 | — | 60 credits/month | 1 social account; 720p export; 3-day storage; **watermarked** ([vizard.ai/pricing](https://vizard.ai/pricing); [coldiq.com/tools/vizardai](https://coldiq.com/tools/vizardai)) |
| Creator | $29/mo (monthly billing, per [eesel-style aggregator]) or "$16.90/mo" per another aggregator | $14.50/mo billed yearly | 600 credits/month (≈7,200–69,600 credits/year across sub-tiers) | No watermark, 4K export, manages 6 social accounts ([coldiq.com/tools/vizardai](https://coldiq.com/tools/vizardai); [vizard.ai/pricing](https://vizard.ai/pricing)) |
| Business | $39/mo (monthly) | $19.50/mo billed yearly (one source says $22.80/mo effective) | Same credit tiers as Creator, scaled up | Team collaboration, brand kits, up to 20 social accounts ([coldiq.com/tools/vizardai](https://coldiq.com/tools/vizardai)) |
| Enterprise | Custom | Custom | 10,000+ credits | Custom ([coldiq.com/tools/vizardai](https://coldiq.com/tools/vizardai)) |

**Note on price disagreement across sources**: Monthly list prices for Creator/Business are reported inconsistently — $29/$39 by one aggregator vs. $16.90/$22.80 "monthly-billing-with-annual-style-discount" by another ([coldiq.com/tools/vizardai](https://coldiq.com/tools/vizardai) vs. other search-result aggregation). The one figure that is consistent across every source checked is the **annual effective rate: $14.50/mo Creator, $19.50/mo Business** — treat that as the reliable number and the raw monthly figures as unconfirmed/possibly stale.

**What a credit buys**: Officially confirmed — "1 credit = 1 minute of video" for uploads, charged against the **source/input file length**, not output length ([docs.vizard.ai/docs/pricing](https://docs.vizard.ai/docs/pricing); [vizard.ai/pricing](https://vizard.ai/pricing)). This is identical semantics to OpusClip's credit system.

**API usage**: Included in all paid plans at no extra subscription cost; API submissions consume the same upload-minute credits as web uploads ([docs.vizard.ai/docs/pricing](https://docs.vizard.ai/docs/pricing)). Platform limits: max video length 600 minutes, max file size 10GB, max resolution 4K ([docs.vizard.ai/docs/pricing](https://docs.vizard.ai/docs/pricing)).

**Watermark policy**: Free tier watermarked; Creator tier and above remove it ([vizard.ai/pricing](https://vizard.ai/pricing)).

**Reviews**: G2 rating 4.7/5 across 340 reviews ([g2.com/products/vizard-corp-vizard/reviews](https://www.g2.com/products/vizard-corp-vizard/reviews), per search synthesis). Common complaint: caption/subtitle positioning "doesn't dynamically adjust based on the chosen layout," so switching aspect ratios requires manually repositioning captions; one detailed review also reports "slow editing and generation plus failed downloads on the paid version" ([search synthesis, unable to fetch primary G2 page directly]). No free trial period exists beyond the permanent free tier ([search synthesis]).

### 2.2 Processing Speed

- One hands-on review reported a 1-hour video processed in 8 minutes ([cracked.ai tool review, via search synthesis]).
- Another source: "a 1-hour podcast usually finishes in a few minutes on Creator and above plans" ([search synthesis]).
- A third data point: 45-minute videos process in 3–6 minutes, implying a 1-hour video would run somewhat longer than that range ([search synthesis]).
- Vizard's own marketing claims results come back "instantly—upload your video, and AI generates ready-to-post clips with just one click," and separately brands itself "10x faster" than manual editing and "90% cheaper than hiring an editor" (a user quote on the homepage cites paying "around $400 to create 10 clips" via freelancers as the baseline being beaten) ([vizard.ai homepage, fetched directly](https://vizard.ai/)).

**Cross-check verdict**: 3 independent sources converge on roughly 5–10 minutes for a 1-hour source video — consistent with OpusClip's comparable figures, suggesting this is close to an industry-standard processing time for this class of tool.

**Streaming/partial results**: Not confirmed. Official API docs describe a poll-or-webhook retrieval pattern *after* a processing job completes ([docs.vizard.ai/docs/retrieve-video-clips](https://docs.vizard.ai/docs/retrieve-video-clips), via search synthesis) — no evidence of clips appearing incrementally before the full video finishes.

### 2.3 Editor / Studio UX

- **Timeline model**: Hybrid — a **transcript-based text editor** (cut/trim/remove silence by deleting words) *plus* a traditional **multi-track timeline** for frame-accurate control, letting users "layer transitions, animations, and custom B-roll" ([vizard.ai/tools/transcript-based-video-editing](https://vizard.ai/tools/transcript-based-video-editing); search synthesis). Vizard explicitly brands this "Timeline Editing... down to seconds-level" precision on its homepage ([vizard.ai homepage](https://vizard.ai/)).
- **Word-level transcript editing**: Yes — deleting words in the transcript view cuts the corresponding video segment ([vizard.ai/tools/transcript-based-video-editing](https://vizard.ai/tools/transcript-based-video-editing)).
- **Undo/redo, autosave, multi-select/batch**: Not documented in any source found (a real gap — see summary below). Batch *creation* of clips is implied ("get multiple clips and upload simultaneously") but explicit batch-*editing* or undo/redo UI was not confirmed.
- **Preview vs. export fidelity**: No specific complaint thread found for Vizard specifically (unlike Submagic, where this was explicitly reported).

### 2.4 B-Roll

- **Automatic or manual**: Both — "multi-modal AI analyzes your video's voiceover, visuals, sound, and abstract concepts to automatically select and overlay the perfect B-roll," while users "can easily upload your own images and videos to the editor and place them exactly where you want them" ([vizard.ai/tools/ai-b-roll-generator](https://vizard.ai/tools/ai-b-roll-generator), fetched directly).
- **Stock providers**: Storyblocks and Pexels, confirmed twice in the same fetched page: "high-quality stock libraries like Storyblocks and Pexels" ([vizard.ai/tools/ai-b-roll-generator](https://vizard.ai/tools/ai-b-roll-generator)).
- **AI-generated b-roll**: Yes, and notably more advanced than any other competitor found — Vizard's "AI Studio" lets users "generate unique, high-definition videos or images" using **named third-party generative models: Veo, Sora, Kling, and Wan** ([vizard.ai/tools/ai-b-roll-generator](https://vizard.ai/tools/ai-b-roll-generator)). The homepage also names a "Seedance 2.0" AI studio feature ([vizard.ai homepage](https://vizard.ai/)) — likely referencing ByteDance's Seedance video-generation model, suggesting at least five different generative video/image models are pipelined in for custom b-roll.
- **Placement/timing logic**: Multimodal analysis of "voiceover scripts, visual elements, background audio, and even abstract concepts" — explicitly more than simple keyword search, though not stated to be a named LLM ([vizard.ai/tools/ai-b-roll-generator](https://vizard.ai/tools/ai-b-roll-generator)).
- **User upload**: Confirmed, full creative control to upload and place custom footage ([vizard.ai/tools/ai-b-roll-generator](https://vizard.ai/tools/ai-b-roll-generator)).
- **Library browser/timeline lane**: Not explicitly described in any source found.

### 2.5 Captions

- **Number of presets**: No exact count found despite repeated searching. Marketing copy describes "a variety of dynamic, eye-catching subtitle styles" ranging "from simple two-line subtitles to karaoke-highlight animations," but never states a total ([search synthesis]).
- **Animation styles**: Karaoke-style highlight animations are named explicitly; described generally as "dynamic animations" without an itemized list ([search synthesis]).
- **Emoji auto-insertion**: Confirmed via homepage feature name "AI Captions + AI Emoji" ([vizard.ai homepage](https://vizard.ai/)), plus a dedicated "AI Emoji Generator" that "embeds AI-chosen emojis to draw attention and enhance emotional appeal" ([search synthesis].
- **Multi-language**: Two different figures found for caption *generation* — "39 languages" per one source ([search synthesis]) vs. "35+ languages" per another ([vizard.ai/blog/10-most-advanced-multilingual-ai-caption-and-transcription-tools-in-2025](https://vizard.ai/blog/10-most-advanced-multilingual-ai-caption-and-transcription-tools-in-2025)) — close enough to be the same underlying figure reported slightly differently (~35–39). **Translation** reach is much broader and consistently cited: "100+ languages" appears on both the homepage and docs pages ([vizard.ai homepage](https://vizard.ai/); [coldiq.com/tools/vizardai](https://coldiq.com/tools/vizardai)), with one blog citing "over 150 languages" for translation specifically ([search synthesis]) — flagging this as a minor disagreement (100+ vs. 150+).
- **Translation/dubbing**: Caption translation into 100+ languages confirmed on the official homepage ([vizard.ai/](https://vizard.ai/)). No full voice-dubbing product was confirmed (contrast with Klap/Submagic).

### 2.6 Differentiators

- **Core positioning**: "Repurpose" is the central verb across Vizard's marketing — "AI-powered video editing and clipping tool for repurposing long-form videos into engaging clips" ([toolify.ai/tool/vizard](https://www.toolify.ai/tool/vizard)); homepage tagline: "Turn your long video into viral clips with AI magic" ([vizard.ai/](https://vizard.ai/)).
- **Named differentiators**: "AI B-roll" with named generative-model backing (Veo/Sora/Kling/Wan/Seedance — see B-roll section), "Brand Template," multi-format templates for four short-form aspect ratios (9:16, 1:1, 4:5, 16:9) ([vizard.ai homepage](https://vizard.ai/); [search synthesis]).
- **Cost/speed claims**: "10x Faster than manual clipping," "90% Cheaper than hiring an editor," with a specific comparator figure — a user quote citing "$400 to create 10 clips" via freelancers as the old baseline ([vizard.ai/](https://vizard.ai/)).
- **API-first differentiation**: REST API included starting at the Creator tier, positioned by a comparison aggregator as a differentiator versus competitors that gate API access to higher/custom tiers ([whipscribe.com/tools/clipping](https://whipscribe.com/tools/clipping)).
- **Scale claim**: "Largest review base" with "10M+ users" cited by a comparison aggregator ([whipscribe.com/tools/clipping](https://whipscribe.com/tools/clipping)) — note this 10M figure is identical to the one OpusClip review titles use for OpusClip, so at least one of these two claims may be stale, recycled, or refer to different metrics (registered accounts vs. active users); could not verify independently.
- **Weakness noted in comparison content**: "AI is fast, but it's not always intuitive" ([submagic.co/vs/vizard-vs-klap](https://www.submagic.co/vs/vizard-vs-klap) — note this is a competitor's own comparison page, so treat as a biased source, but included for completeness since it's the kind of head-to-head positioning language the market uses).

---

## 3. Klap

### 3.1 Pricing (2026)

Klap's own pricing page ([klap.app/pricing](https://klap.app/pricing)) would not render its tier details via automated fetch (JS-heavy page returned only header/footer chrome on three separate attempts). Figures below are cross-checked across three independent secondary sources that agree closely:

| Tier | Monthly | Annual (effective monthly, ~20% off) | Uploads/mo | Clips/mo | Max video length | Resolution | Notes |
|---|---|---|---|---|---|---|---|
| Starter/Creator | $29/mo | $23/mo | 10 videos | 100 clips | 45 minutes | HD/1080p | All caption styles + brand kit included ([dupple.com/tools/klap-ai](https://dupple.com/tools/klap-ai); confirmed independently by [submagic.co/vs/vizard-vs-klap](https://www.submagic.co/vs/vizard-vs-klap) which cites "$23/month" as one of three Klap tiers) |
| Pro/Restream | $79/mo | $63/mo | 30 videos | 300 clips | 2 hours | 4K | Adds AI dubbing in 29 languages ([dupple.com/tools/klap-ai](https://dupple.com/tools/klap-ai); [joinsecret.com/klap](https://www.joinsecret.com/klap)) |
| Pro+ | $189/mo | $151/mo | 100 videos | 1,000 clips | 3 hours | 4K | AI dubbing included ([dupple.com/tools/klap-ai](https://dupple.com/tools/klap-ai)) |
| Business | Custom (via Discord/sales) | — | — | — | — | For agencies ([joinsecret.com/klap](https://www.joinsecret.com/klap)) |

Three independent figures — a search-engine synthesis of dupple.com, a direct fetch of Submagic's own comparison page ($23/$63/$151), and the earlier joinsecret/traksource results ($29/$79/$189 monthly) — agree with each other almost exactly (the two sets are the same prices at monthly vs. 20%-off-annual billing), so this pricing grid is **well cross-checked**, unlike some of the other three vendors.

**Free tier — sources disagree substantially**:
- One set of sources describes a **time-boxed trial**: "free 15-minute trial of video source with full Creator plan access, no credit card required" ([joinsecret.com/klap](https://www.joinsecret.com/klap), via search synthesis).
- A different set describes a **recurring monthly free allowance without a credit card**: "upload 1 video (max 10 minutes) and generate up to 10 clips per month," with the resulting clips watermarked and not downloadable ([search synthesis, multiple sources]).
- A third variant: "3-day free trial on paid plans if you enter a credit card," with full paid-tier feature access during the trial window ([search synthesis]).
- **This is flagged as an open discrepancy** — it's possible Klap has changed its free-tier structure between when these sources were written, or that the no-card free allowance and the card-gated paid trial are two different, simultaneously-offered on-ramps. Recommend verifying live on klap.app before quoting a specific free-tier number externally.

**Watermark policy**: Consistent across sources — paid tiers (Klap/Pro and above) are watermark-free and "ready for commercial posting"; free/trial-generated clips carry a watermark ([dupple.com/tools/klap-ai](https://dupple.com/tools/klap-ai), search synthesis).

**What a credit buys**: Klap does not appear to use a "credits" abstraction at all (unlike OpusClip/Vizard) — its quota model is direct: N video uploads per month, each capped at a max duration, producing up to M output clips per month. This is a meaningfully different pricing mechanic from OpusClip/Vizard's per-minute credit systems and is worth noting as a product-design difference, not just a pricing difference.

**Reviews**: G2 rating approximately 4.5 per a comparison aggregator ([whipscribe.com/tools/clipping](https://whipscribe.com/tools/clipping)) — could not locate or fetch a primary G2 Klap product page directly to get an exact review count (search results kept surfacing an unrelated "Klapty" G2 listing instead). Trustpilot shows only 30 reviews with "mixed" sentiment ([trustpilot.com/review/klap.app](https://www.trustpilot.com/review/klap.app), via search synthesis) — a much smaller review base than OpusClip, Vizard, or Submagic.

### 3.2 Processing Speed

This is the **most contradictory data point found across all four vendors** — sources disagree by an order of magnitude or more:

- Klap's own marketing / feature-page copy: "Klap's clip generator scans your long videos and generates 10+ viral-ready short clips in 30 seconds," and elsewhere "in about 30 seconds" regardless of source length ([klap.app/tools/ai-clip-generator](https://klap.app/tools/ai-clip-generator), fetched directly).
- A hands-on review reports a **1-hour video took about 12 minutes** to process ([skywork.ai Klap review, via search synthesis]).
- Another hands-on account: a 15:02-minute video produced 19 clips in about 14 minutes ([search synthesis]).
- A shorter test: a 10-minute YouTube video generated 9 clips in under 4 minutes ([search synthesis]).
- A third-party review states plainly: "Processing time can be slow during peak hours (15-30 minutes per video)" ([dupple.com/tools/klap-ai](https://dupple.com/tools/klap-ai), fetched directly).
- One report notes a 40-minute video **failed to process completely**, suggesting reliability issues at longer durations ([search synthesis]).

**Cross-check verdict**: Klap's own "30 seconds" marketing claim is contradicted by every independent hands-on report found, which instead describe low-double-digit minutes for hour-long content and explicit "15-30 minutes during peak hours" slowdowns, plus at least one outright failure on a 40-minute source video. Treat the "30 seconds" figure as an unreliable best-case/marketing number, not a representative processing time.

**Streaming/partial results**: Klap's API supports webhook callbacks fired "when each video finishes," and the platform "processes batches in parallel" so users queuing multiple long videos can see individual results complete independently ([search synthesis]) — this is closer to a real "progressive delivery" story than what was found for OpusClip or Vizard, though it's parallel-batch delivery across multiple *source* videos, not incremental/partial delivery *within* a single video's processing job.

### 3.3 Editor / Studio UX

- **Timeline model**: **Not a traditional timeline** — Klap's primary editing paradigm is **transcript-based**: "Klap turns your video into an editable transcript. Highlight any sentence to keep it, strike one to cut it, and the video updates instantly. No timeline scrubbing, no guessing where the cut should land, no waveform peering" ([search synthesis, multiple review sources describing the same UX]). A comparison aggregator explicitly frames this as a limitation for multi-speaker content: Klap is "single-source still" rather than true multi-source split-screen ([whipscribe.com/tools/clipping](https://whipscribe.com/tools/clipping)).
- **Word-level transcript editing**: Yes, sentence-level (not confirmed down to individual word-level granularity) cut/keep editing directly on the transcript ([search synthesis]).
- **Keyboard shortcuts**: Not documented in any source found — likely because the transcript-first paradigm de-emphasizes timeline-style keyboard scrubbing.
- **Undo/redo, autosave, multi-select/batch**: Not documented for the editor itself in any source found. Batch *upload/processing* is confirmed (see 3.2), but that's a processing-queue feature, not an editor-level multi-select feature.
- **Quality/complaint signal**: One review states plainly: "The built-in editor is sluggish and lacks precision controls" and "No real-time preview during caption editing" ([dupple.com/tools/klap-ai](https://dupple.com/tools/klap-ai), fetched directly) — this is a meaningful, specific complaint about preview fidelity, distinct from (but similar in spirit to) the Submagic preview/export mismatch complaint below.
- **Post-generation editing**: Users open a web editor to adjust start/stop times, fix caption typos, and adjust text styling/colors — described as light-touch cleanup rather than a full NLE-style workflow ([search synthesis]).

### 3.4 B-Roll

- **Automatic**: Yes, described as "a newer feature that adds stock footage overlays at relevant moments" ([search synthesis, multiple sources agree on this framing]).
- **Quality signal**: Explicitly hit-or-miss per reviewers: "sometimes the AI picks appropriate visuals, sometimes they feel generic" ([search synthesis]).
- **Manual override**: Confirmed available ([search synthesis]).
- **Stock provider**: **Not disclosed in any source found** — this is a genuine gap. Neither Klap's own b-roll-adjacent pages nor third-party reviews name a specific stock footage partner (contrast with Vizard/Submagic, both of which explicitly name Storyblocks). The official [klap.app/tools/ai-clip-generator](https://klap.app/tools/ai-clip-generator) page, fetched directly, contains **no b-roll information at all**, suggesting b-roll may be a secondary/recently-added feature not yet prominently documented.
- **AI-generated b-roll**: Not confirmed either way — no source mentions a generative image/video model for Klap's b-roll (unlike Vizard's explicit Sora/Kling/Veo/Wan integration).
- **Placement/timing logic**: Not detailed beyond "relevant moments" — no confirmation of LLM-based semantic cueing vs. simple keyword matching.
- **User upload / library browser / timeline lane**: Not documented in any source found.

**Overall**: B-roll is clearly the least-developed and least-documented feature of Klap's product relative to the other three competitors.

### 3.5 Captions

- **Number of presets**: Not given as an exact count; described only qualitatively as "multiple caption styles (bold, minimal, colorful)" ([search synthesis]).
- **Animation/styling**: "Animated captions with full customization of font, color, size, emoji, animation style, and layout"; auto-highlighting of keywords ([search synthesis]). One review calls captions "the most polished part of Klap" ([dupple.com/tools/klap-ai](https://dupple.com/tools/klap-ai)).
- **Emoji auto-insertion**: Confirmed — "emoji highlighting" and "auto-highlighting of key words and emoji placement within captions" ([search synthesis]).
- **Multi-language (captions)**: Two figures found, both plausible depending on when measured — "52 languages" per Klap's own clip-generator page (fetched directly: "Captions in 52 languages," [klap.app/tools/ai-clip-generator](https://klap.app/tools/ai-clip-generator)), vs. "50+" per a comparison aggregator ([whipscribe.com/tools/clipping](https://whipscribe.com/tools/clipping)) — these are consistent with each other (52 rounds to "50+").
- **Translation/dubbing**: Klap has a **named AI Dubbing feature**, gated to Pro and Pro+ tiers, translating and dubbing clips into **29 languages with voice matching** ([search synthesis, multiple sources agree on "29 languages"; cross-checked against the pricing grid in 3.1 which independently lists "AI dubbing in 29 languages" as a Pro-tier feature]). This is positioned in market commentary as a clear edge over OpusClip, which "lacks this feature entirely" ([search synthesis citing a Klap-vs-OpusClip comparison]).

### 3.6 Differentiators

- **Homepage tagline** (fetched directly, [klap.app](https://klap.app)): "Turn videos into viral TikToks, Reels & Shorts"; hero headline: "Create TikToks, Reels, Shorts from your long videos in just one click."
- **Named features**: "AI Reframe 2" ("Resize your videos for any platform with our most advanced AI yet"), "Auto Reframing" (keeps the important subject in frame), "Engaging Captions," "Publish & Schedule" ([klap.app](https://klap.app)).
- **Scale claim**: "8.5M clips made by 3.5M creators" ([klap.app](https://klap.app)) — notably smaller than OpusClip's and Vizard's claimed "10M users," consistent with Klap's much smaller review-site footprint (30 Trustpilot reviews vs. hundreds for the other three).
- **Virality Score**: Klap has its own directly-competing feature — every clip/segment scored 0–100 on four signals: hook quality (first-3-second grab), edit pacing, topic relevance, and caption keyword density; highest-scoring segments are the ones generated as clips in the first place (i.e., scoring happens *before* clip selection, not just after) ([search synthesis]).
- **Speed-and-simplicity positioning**: "Never spend time and money on video clipping again"; "One AI video editor tool that does it all" ([klap.app](https://klap.app)).
- **AI dubbing as a named wedge against OpusClip**: repeatedly surfaced in comparison content as Klap's clearest capability gap over OpusClip specifically ([search synthesis, multiple Klap-vs-OpusClip comparison articles]).
- **Auto-format detection**: "Auto-detects talking-head / interview / panel formats" and applies appropriate framing automatically, per a comparison aggregator ([whipscribe.com/tools/clipping](https://whipscribe.com/tools/clipping)).

---

## 4. Submagic

### 4.1 Pricing (2026)

Official pricing page fetched directly ([submagic.co/pricing](https://www.submagic.co/pricing)):

| Tier | Monthly (per member) | Annual (per member, "41% discount") | Video allowance | AI Credits/mo | Watermark | API |
|---|---|---|---|---|---|---|
| Free | $0 | — | 3 videos/month, 200MB & 1 min 30 sec max | — | **Yes, Submagic watermark** | — |
| Starter | $19 | $12 | 15 videos, max 2 min each | 3/month | None | 10 min/month |
| Pro | $39 | $23 | 40 videos, max 5 min each | 6/month | None | 10 min/month |
| Business + API | $69 | $41 | 100 videos, max 30 min each | 15/month | None | 100 min/month; custom base fee $120/month |
| Custom | — | — | Built around usage | — | None | Dedicated CSM, SSO/advanced security |

**Add-on**: "Magic Clips" add-on, +$19/mo (or +$12/mo annual) — "Get viral clips from 10 long videos/month with AI" ([submagic.co/pricing](https://www.submagic.co/pricing)). This is notable: Submagic's *core* product is edited-short polishing (captions/b-roll/zooms on videos you already cut to short form), and long-video-to-clips extraction (the OpusClip/Klap/Vizard core use case) is sold as a bolt-on, not the base product.

**API credit packs** (separate from subscription): 500–10,000 minute blocks priced at $0.10–$0.15/minute ([submagic.co/pricing](https://www.submagic.co/pricing)).

**What counts as a "video" for quota purposes**: A video/export unit, capped by both a count-per-month and a max-duration-per-video that scales with tier (2 min → 5 min → 30 min) — a structurally different quota model from OpusClip/Vizard's per-source-minute credits, and different again from Klap's upload-count-plus-clip-count model.

**Rollover/expiration**: No rollover or expiration policy stated on the official pricing page ([submagic.co/pricing](https://www.submagic.co/pricing)).

**Cross-check**: A third-party aggregator's numbers ($14/$23/$40/$60 tiers, via [whipscribe.com/tools/clipping](https://whipscribe.com/tools/clipping)) are close-but-not-identical to the official annual per-member prices ($12/$23/$41) — likely rounding or slight staleness in the third-party source. **The official page ($12/$23/$41 annual; $19/$39/$69 monthly) should be treated as authoritative.**

**Reviews**: 4.7/5 on G2 across "84 verified reviews" combined G2+Capterra per one source, or 83 reviews on G2 alone per another ([search synthesis]) — consistent in the 83-84 range. Notably strong small-business skew: 92.8% of reviews from small businesses ([search synthesis]).

### 4.2 Processing Speed

- Submagic's own positioning: videos go from "upload to export in under two minutes for standard short-form clips"; a typical 3-minute video with AI Auto-Edit enabled completes in "roughly 2–5 minutes" end-to-end ([search synthesis]).
- One user test: upload processed in "under 30 seconds" ([search synthesis]).
- Caption/transcription accuracy claims: "98.8% caption accuracy" per a GitHub mirror of Submagic's own marketing copy ([github.com/hmsq7518/submagic](https://github.com/hmsq7518/submagic)), and elsewhere "99%+ accuracy" across "100+ languages" ([search synthesis]) — both figures appear in circulation; treat ~99% as the consistent ballpark.
- **Reliability complaint**: "Export delays are the most common complaint about Submagic on G2, with videos occasionally getting stuck in processing during peak usage periods" — though "Submagic 2.0 improved export speed by about 30%" per the same source ([search synthesis]).

**Important scope caveat for this metric**: Submagic's core product operates on **already-short-form footage** (its plans cap individual videos at 2/5/30 minutes depending on tier — see 4.1), unlike OpusClip/Vizard/Klap, which are built around ingesting a full 1-hour-plus source and extracting clips from it. The "Magic Clips" add-on is the closer analog to the other three tools' core function, but no source found gives a specific processing-time claim for a 1-hour input specifically through Magic Clips — this is a genuine gap, and comparing raw "processing speed" numbers directly against OpusClip/Vizard/Klap somewhat conflates two different workloads (short-video polishing vs. long-video extraction).

**Streaming/partial results**: No source confirms incremental/partial delivery during processing.

### 4.3 Editor / Studio UX

- **Timeline model**: Primarily **transcript-based** — "cut, trim, and remove silences by editing the transcript instead of scrubbing through footage." One review frames this sharply: "It's not a general-purpose editor — there's no timeline, no color grading panel, no multi-track audio mixing" ([search synthesis]). However, the official B-roll feature page states users can "Edit by transcript or switch to timeline editing mode" ([submagic.co/features/b-roll](https://www.submagic.co/features/b-roll), fetched directly) — so a timeline mode does exist as an alternative view, contradicting the "no timeline" framing above. **Flagging this as a direct contradiction between two sources**: one review says there is no timeline at all; Submagic's own product page says there is a timeline editing mode you can switch to. The official source should be weighted more heavily.
- **Control panel**: A "Boost" panel toggles AI features independently — AI Captions, Remove Silences, AI Auto Zooms, AI Auto B-rolls — plus an "AI Tools" section for Hook Title generation, Clean Audio, and Remove Bad Takes ([search synthesis]).
- **Undo/redo, autosave, multi-select/batch**: Not documented in any source found — a real gap, could not confirm either way despite dedicated searching.
- **Preview vs. export fidelity — confirmed complaint**: A Product Hunt reviewer explicitly reported: "the trim, preview, final export do not align" ([producthunt.com/products/submagic/reviews](https://www.producthunt.com/products/submagic/reviews), via search synthesis). **This is the clearest, most specific preview/export-mismatch complaint found for any of the four vendors in this research.**
- **B-roll library management**: Users can save uploaded custom b-roll "to your library for easier access next time," and set precise on-screen duration per b-roll insert ([submagic.co/features/b-roll](https://www.submagic.co/features/b-roll)).

### 4.4 B-Roll

- **Automatic or manual**: Both, explicitly one-click for full automation: "Choose to manually insert B-rolls or use our Magic AI b-roll generator to automate the entire process—in 1 click" ([submagic.co/features/b-roll](https://www.submagic.co/features/b-roll), fetched directly).
- **Stock provider — conflicting evidence**: Multiple secondary/review sources explicitly name **Storyblocks**, with one specific claim of "access to over 4.5 million stock footage options through its partnership with Storyblocks" ([search synthesis, multiple review sources]). However, Submagic's **own official b-roll feature page**, fetched directly, does **not** name Storyblocks anywhere — it only references generic "thousands of B-roll shots" and "royalty free or premium images," and separately name-checks "Pexels, Pixabay" only as general external suggestions, not as Submagic's actual backing providers ([submagic.co/features/b-roll](https://www.submagic.co/features/b-roll)). **This is flagged as unresolved**: the Storyblocks claim is widely repeated across secondary sources but not confirmed on Submagic's own current feature page — either the page has been de-emphasized/changed since those reviews were written, or the reviews are extrapolating/reprinting older marketing copy.
- **AI-generated b-roll**: The "Magic AI b-roll generator" is described as understanding the transcript and contextually adding relevant footage, but no source specifies whether this is model-generated (à la Vizard's Sora/Kling) versus AI-driven *selection* from a stock library — the weight of evidence (stock-library language throughout) suggests this is AI-driven **selection**, not generation, unlike Vizard.
- **Placement/timing logic**: Explicitly transcript/keyword-based: "The system inserts contextually relevant B-roll... at contextually appropriate moments," matching "clips to keywords in your transcript" ([search synthesis]); users can also manually "Add B-rolls at the precise time and set for how long it should be on screen" ([submagic.co/features/b-roll](https://www.submagic.co/features/b-roll)).
- **User upload**: Confirmed, with a personal reusable library: "upload your own and save them to your library for easier access next time" ([submagic.co/features/b-roll](https://www.submagic.co/features/b-roll)).
- **Library browser**: Confirmed via the reusable personal library described above, plus implied stock browsing ("Choose from royalty free or premium images").

### 4.5 Captions

- **Number of presets**: The most concrete figures found across all four vendors — "12+ animated caption styles" per one source, and separately "35+ animation templates that highlight, bounce, and fade word by word in sync with video" per another ([search synthesis, both figures appear in circulation and may refer to different counting methods — e.g., 12+ "families"/categories containing 35+ total template variations]). The style library is organized by category: "Trending, New, Emoji, Premium, and Speakers" ([search synthesis]).
- **Animation styles**: Fade, slide, bounce, and word-by-word reveal animations, all word-level-synced to speech ([search synthesis]).
- **Emoji auto-insertion**: Confirmed and specifically described as content-aware: "Submagic's emoji subtitle generator automatically suggests relevant emojis based on the content being discussed" ([search synthesis]).
- **Multi-language (captions)**: The clearest — and most internally inconsistent — numbers of any vendor researched. Figures found: "48 languages" (per [coldiq.com/tools/submagic](https://coldiq.com/tools/submagic), fetched directly), "48+ languages with 99% accuracy" (search synthesis), "100+ languages" for caption tone/context understanding (search synthesis), and "123 languages natively" for AI caption generation specifically per Submagic's own translator feature page ([submagic.co/features/ai-video-translator](https://www.submagic.co/features/ai-video-translator), via search synthesis). **These numbers do not reconcile cleanly** — 48 and 123 are not close enough to be rounding of the same figure. Best working interpretation: ~48 languages may refer to a *core/well-supported* caption-generation set, while 100+/123 refers to the broader *translation* reach layered on top — but this is inference, not confirmed by a single source stating both figures with clear scoping.
- **Translation/dubbing**: "AI Video Translator" supports 100+ languages, explicitly **subtitle-based, not audio dubbing**: "This isn't robotic voice cloning or uncanny valley lip sync... keeps your original audio and personality intact—just adds high-quality, translated subtitles" ([search synthesis, quoting Submagic's own positioning]). This is an explicit product-design choice differentiating Submagic from Klap (which does voice-dubbing) — Submagic translates text only, deliberately avoiding synthetic voice/lip-sync. One review adds a caveat: "translation capabilities are somewhat generic, handling major languages well but failing... regional nuances" ([search synthesis]).

### 4.6 Differentiators

- **Homepage tagline** (fetched directly, [submagic.co](https://www.submagic.co/)): "Edit shorts 10x faster with AI"; hero headline: "The new way to edit videos faster. From raw footage to viral shorts in 1 click."
- **Named features** (from homepage): AI Captions, AI Auto Edit, Magic Clips, **AI Actors Studio**, B-Roll, Auto-Zoom, **AI Eye Contact** (a feature not found at any of the other three competitors), AI Video Translator, Transitions, Sound Effects, Background Music, Video Editing API ([submagic.co](https://www.submagic.co/)).
- **Quantified marketing claims**: "Join 4M+ businesses that save 10+ hours every week"; "+40% average views increase"; "80% reduction in editing cost" ([submagic.co](https://www.submagic.co/)) — notably, Submagic is the only one of the four vendors researched that publishes a specific claimed *engagement lift* percentage (+40% views) rather than only efficiency/cost claims.
- **Positioning vs. competitors**: Submagic's own comparison page states its differentiator directly: "Caption preset library is unmatched — viral templates that already match what's working," and frames itself as the "Fastest path from 'raw clip' to 'looks like every other top creator's clip'" — an explicit acknowledgment that its value is in *finishing/polishing* an already-cut short, not in *discovering* clips from long-form source, which lines up with the core-product-vs-add-on structure noted in Pricing above ([whipscribe.com/tools/clipping](https://whipscribe.com/tools/clipping); [submagic.co/vs/vizard-vs-klap](https://www.submagic.co/vs/vizard-vs-klap)).
- **Explicit competitive framing found**: Submagic's own vs.-page states Vizard's AI is "fast, but not always intuitive," and that Klap users will "still need to quality-check the output... more assembly line than artisan" ([submagic.co/vs/vizard-vs-klap](https://www.submagic.co/vs/vizard-vs-klap), fetched directly — bias caveat: this is Submagic's own marketing page about its rivals).
- **Limitation noted by outside comparison**: Submagic does "per-speaker subtitle colouring but no actual split-screen" for multi-speaker content ([whipscribe.com/tools/clipping](https://whipscribe.com/tools/clipping)).

---

## Cross-Vendor Notes & Data-Quality Flags

- **Pricing confidence ranking** (highest to lowest confidence, based on how many independent sources agreed and whether an official page was directly fetched): **Submagic** (official page fetched cleanly, numbers internally consistent) ≈ **OpusClip** (official page fetched, credits mechanic clearly confirmed) > **Klap** (official page would not render via fetch, but 3 independent secondary sources agree closely) > **Vizard** (official docs page confirmed the credit mechanic but not clean tier pricing; raw monthly list prices disagreed by roughly 2x across sources — only the annual effective rate is solid).
- **Processing-speed confidence ranking**: OpusClip and Vizard both have multiple independent hands-on reports converging on ~5–10 minutes for a 1-hour video — reasonably solid. **Klap is the standout disagreement**: its own "30 seconds" marketing claim is contradicted by every independent test found (12 minutes to 30 minutes, plus at least one outright failure on a 40-minute video) — this is the single largest speed-claim-vs-reality gap found in this research. Submagic's speed claims are hard to compare directly since its core product operates on already-short content, not 1-hour sources.
- **Universal gap**: none of the four vendors could be confirmed, in any source (official or third-party), to show/generate clips progressively *before* a single video's processing job completes. All four appear to be batch-process-then-deliver, despite fast enough total times that this may not matter much in practice. Klap's parallel-batch-across-multiple-videos-with-webhooks is the closest thing to "streaming" found, but that's parallelism across jobs, not partial results within one job.
- **B-roll stock-provider confidence**: Vizard (Storyblocks + Pexels) and OpusClip (Pexels only, with Storyblocks/Getty as stated future roadmap) are both confirmed directly from official pages. **Klap's b-roll stock provider is undisclosed anywhere** — a genuine unanswered question. **Submagic's Storyblocks partnership is asserted repeatedly by third parties but not confirmed on Submagic's own current b-roll feature page** — flagged as unresolved rather than confirmed.
- **Dubbing (audio) vs. translation (text-only) is a real product-line split worth tracking**: Klap does true voice dubbing (29 languages, described as "with voice matching"). Submagic explicitly does *not* do voice dubbing by design choice ("keeps your original audio... just adds translated subtitles") and markets that restraint as a feature, not a gap. OpusClip and Vizard both appear to offer caption/subtitle translation only, with no dubbing product confirmed for either.

---

## Data Points Not Found Despite Searching

1. **Klap's stock b-roll footage provider** — not named in any source, official or third-party. Its official clip-generator page has no b-roll content at all.
2. **Exact caption-preset counts for OpusClip and Vizard** — both describe preset *categories* qualitatively but never state a total number of templates, unlike Submagic ("12+"/"35+") and Klap ("multiple... bold, minimal, colorful" — also not an exact count, but at least the language count, 52, is precise).
3. **Klap's current free-tier structure** — three mutually inconsistent descriptions found (15-min one-time trial vs. recurring 1-video/10-clip monthly allowance vs. credit-card-gated 3-day full-access trial). Could not resolve which is currently accurate without a live account signup, which was out of scope for this research.
4. **Undo/redo, autosave, and multi-select/batch-editing behavior for Vizard, Klap, and Submagic's editors** — essentially undocumented in any source for these three (OpusClip has at least indirect confirmation of cloud autosave and a described undo/redo history system).
5. **A specific 1-hour-video processing-time claim for Submagic's "Magic Clips" long-form add-on** — Submagic's speed claims all reference its core short-video-polishing workflow (2–5 minutes for a 3-minute video), not the long-video-extraction workflow that's the direct point of comparison with the other three tools.
6. **Whether any vendor's b-roll placement is confirmed to use an LLM reading transcript semantics** versus simple keyword/entity matching — all four are described only as "AI" or "contextual" without a single source specifying the underlying technique (LLM-based semantic cueing vs. keyword search against a tagged stock index).
7. **A primary-source (G2.com-hosted) page for Klap reviews** — every attempt to reach Klap's actual G2 listing either 404'd, redirected to an unrelated "Klapty" product, or was blocked; the ~4.5 rating figure used here comes from a third-party aggregator quoting G2, not G2 directly.
