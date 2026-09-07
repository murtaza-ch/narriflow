# Competitive Intelligence: Captions.ai, Veed.io, Descript, CapCut (as of 2026-07-26)

> Research method: WebSearch + WebFetch against official pricing/feature pages, help-center docs, G2/Capterra/Trustpilot listings, and head-to-head comparison articles. Every claim below is cited inline. Where sources disagreed on numbers (this happened a lot for Veed pricing and CapCut pricing in particular), it is called out explicitly rather than silently picking one number.

---

## 1. Captions.ai

### 1.1 Pricing (2026)

Official pricing page and Captions' own help-center doc agree on the following structure ([captions.ai/pricing](https://captions.ai/pricing), [captions.ai/help/docs/subscriptions](https://captions.ai/help/docs/subscriptions)):

| Tier | Price/mo | Credits/mo | Notes |
|---|---|---|---|
| Free | $0 | 0 (one-time 60-200 lifetime credits per one source) | Basic trimming, transitions, some media library assets; no generative AI ([captions.ai/pricing](https://captions.ai/pricing)) |
| Lite | $4.99 | — | **Android-only**; manual editing tools, dubbing, caption styles, AI eye contact, denoise ([captions.ai/help/docs/subscriptions](https://captions.ai/help/docs/subscriptions)) |
| Basic | $9.99 | 200 | Removes watermark, 100+ caption templates, basic AI editing, Reddit-to-Video, Script Generator, Camera & Teleprompter ([captions.ai/help/docs/subscriptions](https://captions.ai/help/docs/subscriptions); cross-checked at [eesel.ai/blog/captions-ai](https://www.eesel.ai/blog/captions-ai)) |
| Max (marked "Most Popular") | $24.99 | 500 | AI Edit styles, digital twins/AI Twins (up to 30), chat-based editor, Mirage-generated actors, custom B-roll/music/SFX ([captions.ai/pricing](https://captions.ai/pricing)) |
| Scale 1x | $69.99 | 1,400 | "Most sophisticated tier of generative AI models" ([captions.ai/pricing](https://captions.ai/pricing)) |
| Scale 2x | $139.99 | 2,800 | Same features, 2x credits |
| Scale 4x | $279.99 | 5,600 | Same features, 4x credits |
| Enterprise | Custom | Custom | Bulk credit discounts, dedicated account mgmt, training-data exclusion, beta access ([captions.ai/pricing](https://captions.ai/pricing)) |

**Naming discrepancy found:** The official help doc calls the $9.99 tier "**Basic**," but multiple third-party trackers (eesel.ai, and CapCut/Captions review aggregators) call the same $9.99/200-credit tier "**Pro**" ([www.eesel.ai/blog/captions-ai](https://www.eesel.ai/blog/captions-ai), [www.submagic.co/vs/veed-io-vs-captions-ai](https://www.submagic.co/vs/veed-io-vs-captions-ai)). Likely a recent rename that hasn't propagated to all secondary sources. Similarly, one aggregator (khaby.ai-sourced search result) labels the Scale tiers "Scale 2x/4x/8x" for the same $69.99/$139.99/$279.99 price points that the official page calls "Scale 1x/2x/4x" — same dollar figures and credit counts, different multiplier labels.

**Credit rollover:** "Unused credits roll over to the next month. You can save up to two extra months of unused credits which means your balance can hold up to 3× your monthly allowance" ([captions.ai/pricing](https://captions.ai/pricing)).

**Watermark policy:** Free tier is watermarked; paid tiers (Basic and above) remove it ([www.eesel.ai/blog/captions-ai-pricing](https://www.eesel.ai/blog/captions-ai-pricing); general aggregator consensus).

**Not found despite searching:** an official annual/yearly discounted price — no source (including the official pricing page fetch) surfaced a specific annual number, only that "yearly plans are available at a discount" in general terms.

### 1.2 Processing speed

Captions.ai's marketing is speed-focused but vague on hard numbers: "seconds, not hours," and AI Edit "make[s] fully edited videos in minutes" ([captions.ai/](https://captions.ai/), [captions.ai/features/edit-with-ai](https://captions.ai/features/edit-with-ai)). No specific "1-hour video = X minutes" claim was found anywhere, including on marketing pages, help docs, or third-party reviews — this is a genuine gap despite dedicated searching.

User reports skew negative on speed/reliability: Trustpilot reviews cite "extremely slow loading times," "failed exports," and audio going out of sync after export ([sendshort.ai/guides/captions-review](https://sendshort.ai/guides/captions-review/), summarized also at [www.eesel.ai/blog/captions-ai](https://www.eesel.ai/blog/captions-ai)). One source also mentioned Pro-tier users experiencing upload wait times of up to 360 minutes after 6 AI projects in a month, though this specific figure only appeared in one aggregator and could not be cross-verified on captions.ai's own docs.

**Streaming partial results:** No evidence found either way that Captions.ai shows/generates clips before a full source video finishes processing. Not documented in help center or marketing.

### 1.3 Editor / Studio UX

- Core paradigm: upload footage (or generate an avatar) → pick an "AI Edit" style → AI auto-cuts scenes, overlays B-roll, adds captions/music/transitions in one pass ([captions.ai/features/edit-with-ai](https://captions.ai/features/edit-with-ai)).
- Named AI Edit styles found: Elevate, Paper II, Prime, Bloom, Prism Pro, Impact II, Sketch, Lens, Vista, Pop, Orbit, Y2K, Form, Chalk, Linen, Evo, Focus, Lift, Stack, Align — roughly 20 named styles ([captions.ai/features](https://captions.ai/features)).
- Natural-language / "chat-to-edit" prompting: users can type instructions like "add b-roll of a city at night" and the AI executes it ([www.eesel.ai/blog/captions-ai](https://www.eesel.ai/blog/captions-ai)).
- AI avatars: "Mirage Avatar X" generates a full avatar performance at once — voice, micro-expressions, eye contact, body language ([captions.ai/features/generate-ai-avatars](https://captions.ai/features/generate-ai-avatars)). Users can create a digital twin/"AI Twin" from a single selfie ([www.eesel.ai/blog/captions-ai](https://www.eesel.ai/blog/captions-ai)).
- Eye contact correction: dedicated tool in the editing panel that detects "looking at a script, glancing off to the side, and nervous blinks" and redraws gaze toward camera while preserving expressions ([captions.ai/features/correct-your-eye-contact](https://captions.ai/features/correct-your-eye-contact), [captions.ai/blog/how-to-get-the-perfect-take-ai-eye-contact](https://captions.ai/blog/how-to-get-the-perfect-take-ai-eye-contact)).
- Keyboard shortcuts / traditional multi-track timeline: **not documented** — Captions.ai appears to be architected around its style-preset/prompt-driven workflow rather than a classic NLE timeline; no keyboard-shortcut reference page was found.
- Reviews are split hard on quality/reliability. Two very different rating snapshots turned up: Trustpilot "4 stars, 289 reviews" per one source ([sendshort.ai/guides/captions-review](https://sendshort.ai/guides/captions-review/)) vs. a head-to-head comparison page citing "1.6/5 stars, 54 reviews" for Captions.ai ([www.submagic.co/vs/veed-io-vs-captions-ai](https://www.submagic.co/vs/veed-io-vs-captions-ai)) — a large discrepancy, likely because the second source is a competitor's comparison page (Submagic) with an incentive to make Captions look bad; flagging rather than resolving.
- Common complaints: audio desync after export, slow loads, failed exports, desktop/Android versions lagging feature parity with the main app, weak customer support ([sendshort.ai/guides/captions-review](https://sendshort.ai/guides/captions-review/)).
- Preview-vs-export fidelity: one comparison explicitly notes "no B-roll functionality" for Captions.ai ([www.submagic.co/vs/veed-io-vs-captions-ai](https://www.submagic.co/vs/veed-io-vs-captions-ai)) — this directly **contradicts** Captions' own help docs, which describe a full b-roll system (see 1.4). Likely the comparison page is stale or referring to a specific plan tier; noting the contradiction rather than picking a side.

### 1.4 B-roll

Per Captions' own help center ([captions.ai/help/guides/advanced/broll-media](https://captions.ai/help/guides/advanced/broll-media)), there are **three** ways to add b-roll:
1. **User-uploaded media** — camera roll/files, screen recordings, product demos, personal photos.
2. **Built-in stock library** — photos, videos, GIFs, and stickers, searchable; specific third-party provider (Pexels/Storyblocks/etc.) not named in the docs.
3. **AI-generated** — text-prompt generation of a still image or video clip, powered by named models: **Flux, Imagen, DALL-E, Pika, Ray**, chosen based on desired aesthetic (photorealistic vs. stylized) ([captions.ai/help/guides/advanced/broll-media](https://captions.ai/help/guides/advanced/broll-media)).

Placement/timing: both manual (drag overlay onto timeline, adjust start/end handles, preset positions like Top Half/Bottom Half/Full Screen, transitions like Fade/Pop/Zoom) and automatic via "AI Edit" ("Let AI Edit place B-roll automatically"). A "**Caption Aware positioning**" feature automatically repositions b-roll so it doesn't cover captions ([captions.ai/help/guides/advanced/broll-media](https://captions.ai/help/guides/advanced/broll-media)) — this is a distinctive, specific feature not found documented at any of the other three competitors.

### 1.5 Captions

- **100+ caption styles/templates** — consistent across two independent sources ([captions.ai/features](https://captions.ai/features) and [www.eesel.ai/blog/captions-ai](https://www.eesel.ai/blog/captions-ai), the latter also citing "100+ caption templates" tied to the Basic/$9.99 tier).
- Animation-style specifics (karaoke/pop/bounce naming) were not separately documented from the AI-Edit-style names above; Captions.ai's marketing bundles caption styling into its broader style-preset system rather than listing discrete caption animation names.
- Translation: **100+ languages** ([captions.ai/features](https://captions.ai/features)).
- Dubbing: multi-language AI dubbing with lip-sync/mouth-movement adjustment, cited at **28+ languages** in one review ([www.eesel.ai/blog/captions-ai](https://www.eesel.ai/blog/captions-ai)) — this is somewhat below the 100+ figure quoted for translation/subtitles, suggesting dubbing (which requires lip-sync) supports fewer languages than text translation does.
- Emoji auto-insertion: **not confirmed** — no source explicitly documented an auto-emoji feature for Captions.ai (unlike Veed, see 2.5).

### 1.6 Differentiators

- Homepage tagline: **"AI that edits like a professional editor would"** / "Make better videos, in minutes" / "Skip post-production entirely" ([captions.ai/](https://captions.ai/)).
- Claims 20M users, "editing with taste, not just speed" ([captions.ai/](https://captions.ai/)).
- Signature named features: **Eye Contact correction** and **Mirage Avatar X** AI avatars — these are Captions.ai's most distinctive, most-marketed capabilities and the ones most often cited by competitors and reviewers as its calling card ([captions.ai/features/correct-your-eye-contact](https://captions.ai/features/correct-your-eye-contact), [captions.ai/features/generate-ai-avatars](https://captions.ai/features/generate-ai-avatars)).
- Positioned by third-party comparisons as the mobile-first, "talk-to-camera" specialist: "purpose-built for the talk-to-camera crowd," in contrast to Veed/CapCut's broader editing scope ([www.submagic.co/vs/veed-io-vs-captions-ai](https://www.submagic.co/vs/veed-io-vs-captions-ai); similar framing at [www.fahimai.com/veed-vs-captions-ai](https://www.fahimai.com/veed-vs-captions-ai)).

---

## 2. Veed.io

### 2.1 Pricing (2026) — sources disagree significantly, flagged throughout

Veed's free tier is consistent across sources: **watermarked exports, 10-minute export cap, 720p resolution, 2GB storage, 30 min/month of auto-subtitle/AI-feature usage** ([search aggregation citing fluxnote.io guides](https://fluxnote.io/guides/veed-free-plan-limitations-guide-2026); corroborated by [sharespeak.co/veed-teleprompter-pricing](https://sharespeak.co/veed-teleprompter-pricing)).

Paid tiers are where sources genuinely conflict — five different breakdowns were found:

| Source | Entry tier | Mid tier | Top tier |
|---|---|---|---|
| General web-search consensus | Basic $12/mo (annual) | Pro $25-29/mo (annual) | Business $49-70/mo (annual) |
| [costbench.com/software/ai-video-editing-saas/veed-io](https://costbench.com/software/ai-video-editing-saas/veed-io/) | Creator $12/user/mo, $147/yr | Pro $21/user/mo, $247/yr | Studio $39/user/mo, $465/yr |
| [magichour.ai/blog/veed-pricing](https://magichour.ai/blog/veed-pricing) | Creator $10/mo annual ($20/mo monthly), 6,000 credits/yr | Pro $21/mo annual ($44/mo monthly), 30,000 credits/yr | Studio $35/mo annual ($70/mo monthly), 180,000 credits/yr |
| [www.submagic.co/vs/veed-io-vs-captions-ai](https://www.submagic.co/vs/veed-io-vs-captions-ai) | Lite $10/month | Pro $26/month | — |
| Reddit/Trustpilot mentions (via search) | Entry ~$19/mo | Creator plan £20/mo w/ 500 credits | Annual Pro charge reported at $348/yr |

**This is a real, unresolved discrepancy** — Veed's tier names alternate between Basic/Lite/Creator for the entry paid tier (roughly $10-19/mo) and Pro/Business/Studio for upper tiers, and exact numbers vary by as much as 2x across sources, likely reflecting Veed's frequent pricing changes, regional pricing, and promotional discounting (note: monthly billing is unavailable in India by RBI regulation, forcing annual-only there, per [support.veed.io/en/articles/11433566](https://support.veed.io/en/articles/11433566-how-to-subscribe-and-manage-your-subscription)). Direct WebFetch attempts against veed.io/pricing, G2's Veed pricing page, and TrustRadius's Veed pricing page all failed to return the client-rendered pricing table (403 or empty content) — the live official page is JS-rendered and not scrapable by static fetch. **Best estimate**: Free $0 → entry paid tier ~$10-19/mo → mid tier ~$21-29/mo → top tier ~$35-70/mo → Enterprise custom, but treat exact figures as unverified until checked live on veed.io/pricing.

**Watermark/resolution consistently confirmed:** Free = watermarked + 720p; paid tiers remove watermark, with resolution scaling up to 4K on Pro/Studio-equivalent tiers ([costbench.com](https://costbench.com/software/ai-video-editing-saas/veed-io/), [magichour.ai/blog/veed-pricing](https://magichour.ai/blog/veed-pricing)).

**Credit-system complaint (Trustpilot, via search):** one reviewer reported using 470 of 500 monthly credits to generate a single AI video, then needing 217 more credits just to export it — i.e., the monthly allotment didn't cover creating *and* exporting one video. A blog also noted AI credits are consumed "before rendering," meaning costs can exceed the sticker price ([magichour.ai/blog/veed-pricing](https://magichour.ai/blog/veed-pricing)).

### 2.2 Processing speed

- Auto-caption/transcript generation: **30-90 seconds for a 10-minute video** — this figure was cross-checked and confirmed by two independent sources ([general search aggregation](https://www.veed.io/tools/auto-subtitle-generator-online/video-caption-generator) and the head-to-head [flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization](https://flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization/), which states "Veed.io: 30–90 seconds for a 10-minute video").
- Veed's Subtitle API supports source videos up to **2 hours at ≤1080p, or 1 hour above 1080p** ([www.veed.io/learn/veed-subtitles-api-launch](https://www.veed.io/learn/veed-subtitles-api-launch)).
- The AI Clips feature (long-to-short) accepts uploads with at least 1 minute of spoken audio and up to **3 hours** of speech content ([www.veed.io/tools/auto-video-editor/ai-viral-clip-maker](https://www.veed.io/tools/auto-video-editor/ai-viral-clip-maker)).
- **Streaming partial results:** the official Clips help doc ([support.veed.io/en/articles/11652474-how-to-use-our-clips-feature](https://support.veed.io/en/articles/11652474-how-to-use-our-clips-feature)) only says users "will be able to review the clips" after generation — it does not state whether clips appear progressively or only after full-video completion. No evidence found either way.
- Real-world performance complaints (Capterra reviews, [www.capterra.com/p/193780/VEED/reviews](https://www.capterra.com/p/193780/VEED/reviews/)): the editor becomes "very slow" for videos over 10 minutes, with "constant buffering and lag issues" that one user called "completely unusable," and uploads that "never upload even if you leave it overnight."

### 2.3 Editor / Studio UX

- Browser-only (no offline/desktop app) — a specific limitation noted in a head-to-head with CapCut, which does offer offline editing after download ([www.opus.pro/blog/veed-vs-capcut](https://www.opus.pro/blog/veed-vs-capcut)).
- **Multi-track timeline**: confirmed via Veed's own help docs — "you can stack multiple media tracks vertically... allows for overlaying videos, images, or audio, enabling picture-in-picture effects" ([support.veed.io/en/articles/10804541-timeline](https://support.veed.io/en/articles/10804541-timeline)).
- Keyframing: one third-party comparison claims Veed has "a professional multi-track timeline with keyframing, nested sequences, and frame-accurate edits" ([www.opus.pro/blog/veed-vs-capcut](https://www.opus.pro/blog/veed-vs-capcut)) — but Veed's **own** timeline help doc makes no mention of keyframing at all, only trim/split/reorder/group/zoom/playhead-scrub functions ([support.veed.io/en/articles/10804541-timeline](https://support.veed.io/en/articles/10804541-timeline)). Flagging the keyframing claim as likely overstated by the third party.
- Keyboard shortcuts confirmed directly from Veed's docs: **S** = split selected clip/element; **Ctrl+click** = multi-select elements for grouping; **Delete** = remove empty space between elements ([support.veed.io/en/articles/10804541-timeline](https://support.veed.io/en/articles/10804541-timeline)). This is real (if sparse) documentation of multi-select/batch capability.
- Eye contact correction tool exists on Veed (confirmed indirectly — a Capterra reviewer specifically complained the "eye-correction tool" made them "look like some sort of mutant," which confirms the feature exists even though the review is negative about quality) ([www.capterra.com/p/193780/VEED/reviews](https://www.capterra.com/p/193780/VEED/reviews/)).
- Reliability complaints: reviewers reported the system reverting completed edits to previous versions "without warning or the ability to recover lost work" — a serious autosave/versioning complaint ([www.capterra.com/p/193780/VEED/reviews](https://www.capterra.com/p/193780/VEED/reviews/)).
- Ratings found: **Capterra 3.2/5 (62 reviews)** ([www.capterra.com/p/193780/VEED/reviews](https://www.capterra.com/p/193780/VEED/reviews/)) vs. a different comparison citing **G2-style "4/5, 2,521 reviews"** ([www.opus.pro/blog/veed-vs-capcut](https://www.opus.pro/blog/veed-vs-capcut)) — different review platforms with very different sample sizes and averages; both cited, not reconciled.

### 2.4 B-roll

- **Automatic by default**: Veed's AI B-roll "automatically adds relevant images and video clips to your project, based on the words spoken in your video" — upload video → click "Add B-Roll" → auto-transcribe → auto-generate synced visuals ([support.veed.io/en/articles/11829765-how-to-use-ai-b-roll](https://support.veed.io/en/articles/11829765-how-to-use-ai-b-roll)).
- Manual override supported: adjust opacity/filters per clip via an Edit B-Roll panel; regenerate a single clip or all clips for alternate suggestions ([support.veed.io/en/articles/11829765-how-to-use-ai-b-roll](https://support.veed.io/en/articles/11829765-how-to-use-ai-b-roll)).
- Users **can** upload their own media to replace any generated b-roll, or pull from a built-in stock library instead — but Veed's own docs do **not** name specific third-party stock providers (Pexels/Storyblocks/Getty were only speculative attributions from unrelated third-party listicles, not confirmed by Veed itself) ([support.veed.io/en/articles/11829765-how-to-use-ai-b-roll](https://support.veed.io/en/articles/11829765-how-to-use-ai-b-roll)).
- Plan limitation: Free/Lite tier gets **one-time use only** of AI b-roll; Pro tier and above get unlimited usage ([support.veed.io/en/articles/11829765-how-to-use-ai-b-roll](https://support.veed.io/en/articles/11829765-how-to-use-ai-b-roll)).
- Separate standalone tool exists: an "AI Stock Video Generator" (text-to-video) distinct from the transcript-driven auto-b-roll flow ([www.veed.io/tools/ai-video/ai-stock-video-generator](https://www.veed.io/tools/ai-video/ai-stock-video-generator)).
- Placement/timing logic: b-roll is synced "to key points in your narration" — i.e., semantic/transcript-cued placement, not simple keyword search alone, though the exact matching mechanism (LLM vs. keyword) is not disclosed in Veed's public docs.

### 2.5 Captions

- **30+ pre-built caption templates**, per a direct head-to-head with CapCut ([flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization](https://flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization/)).
- Named style presets found: Handwritten, Whisper, Fusion, Glide, Pulse (general search results tied to veed.io tool pages).
- Named animation styles: Box Highlight, Karaoke, Impact, Impact Pop, Reveal, Float In, Scale In, Drop In, Colour Highlight, Rotate & Flip, Rotate & Highlight, Stomp (general search results tied to veed.io/support pages).
- **Emoji auto-insertion confirmed**: Veed has an "Auto Emoji" feature that "automatically adds emojis to your subtitles based on the context," with adjustable size and placement, and a manual emoji editor per subtitle box ([www.veed.io/tools/add-emojis-to-videos](https://www.veed.io/tools/add-emojis-to-videos)).
- Translation language counts — **inconsistent across features**: subtitle translation "over 125 languages" per one source, "130+ languages" per the CapCut head-to-head ([flowith.io](https://flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization/)); AI voice dubbing specifically supports **29 languages**; text-to-speech/voiceover supports **50+ languages**. These are three different numbers for three different features (text translation vs. voice dubbing vs. TTS) — not a contradiction once you note they're measuring different things, but easy to conflate.
- Transcription-accuracy benchmark (from the flowith.io head-to-head, testing across 5 languages): Veed beat CapCut on Spanish (6.8% WER vs. CapCut's 7.2%) but lost on Mandarin (8.1% WER vs. CapCut's 5.9%) ([flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization](https://flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization/)).

### 2.6 Differentiators

- Positioned as the browser-based, professional/team-oriented, brand-consistency platform — explicitly contrasted against CapCut's mobile-first/trend-chasing positioning ([www.opus.pro/blog/veed-vs-capcut](https://www.opus.pro/blog/veed-vs-capcut)).
- **Brand Kit**: shared logos, images, video templates, color palette presets, and custom fonts across a team, positioned as a "single source of truth" for on-brand video at scale; templates are **Enterprise-plan-only** ([www.veed.io/learn/branded-videos-at-scale](https://www.veed.io/learn/branded-videos-at-scale), [support.veed.io/en/articles/11550463-how-to-create-and-use-templates](https://support.veed.io/en/articles/11550463-how-to-create-and-use-templates)).
- Dedicated Enterprise landing page emphasizes global/multi-market brand consistency ([landing.veed.io/enterprise](https://landing.veed.io/enterprise)).
- "Virality Score" / "clip rating" on the AI Clips feature — rates clips out of 100 for viral potential, identifying "emotional peaks and compelling quotes" ([search aggregation of veed.io/tools/auto-video-editor pages](https://www.veed.io/tools/auto-video-editor/ai-viral-clip-maker)).
- Scale claims cited in a comparison piece: 4+ million users, ~$40M annual revenue (2024), and a marketing claim of users "creating videos 30x faster" ([www.opus.pro/blog/veed-vs-capcut](https://www.opus.pro/blog/veed-vs-capcut)) — these are third-party-cited figures, not independently verified against a Veed press release.

---

## 3. Descript

### 3.1 Pricing (2026)

Official pricing page ([www.descript.com/pricing](https://www.descript.com/pricing)) — this is the single cleanest, most internally-consistent pricing data of the four competitors; the numbers below were also independently corroborated by a general web-search summary pulling from Tekpon/Sonix/G2/layer3labs/blitzcutai, which reported identical monthly/annual figures:

| Tier | Monthly | Annual (per mo) | Media minutes/mo | AI credits/mo | Export |
|---|---|---|---|---|---|
| Free | $0 | $0 | 60 min (1 hr) | 100 (one-time) | Watermarked, 720p |
| Hobbyist | $24 | $16 (33% off) | 600 min (10 hrs) | 400 | Watermark-free, 1080p |
| Creator | $35 | $24 (31% off) | 1,800 min (30 hrs) | 800 | Watermark-free, 4K |
| Business | $65 | $50 (23% off) | 2,400 min (40 hrs) | 1,500 | Watermark-free, 4K |
| Enterprise | Custom | Custom | Custom | Custom | Custom (SSO/compliance) |

All paid tiers include multi-language transcription in **25+ languages** ([www.descript.com/pricing](https://www.descript.com/pricing)).

Other usage caps confirmed on the official page: storage from 5GB (Free) to 2TB (Business); file upload cap from 1GB (Free) to 50GB (Business); stock-library search results limited to first 5 (Free) vs. unlimited (Creator+); team seats 1 (Free/Hobbyist/Creator) up to 5 (Business).

**Watermark policy**: Free tier is watermarked at 720p; Hobbyist and above are watermark-free ([www.descript.com/pricing](https://www.descript.com/pricing)).

No rollover policy was mentioned anywhere in the pricing page or help docs — credits appear to reset monthly rather than bank.

### 3.2 Processing speed

- Descript is explicitly **not** a real-time transcription tool — "you record or upload audio, Descript transcribes it, and then you edit the text like a document" (post-hoc, not live) (general search summary).
- Descript published a blog post about infrastructure improvements: previously, applying AI effects like Green Screen or Eye Contact to large videos "sometimes took hours" with the old tech stack; after a rebuild, "they can now spin up cloud GPUs" to apply these "in just a few seconds" ([www.descript.com/blog/article/the-new-descript-how-we-multiplied-the-apps-speed-and-performance](https://www.descript.com/blog/article/the-new-descript-how-we-multiplied-the-apps-speed-and-performance)) — this is Descript's own concrete, citable speed claim, though it's about effect-rendering, not full transcription/export of a 1-hour video specifically.
- No specific "1-hour source video takes X minutes end-to-end" claim was found on Descript's site.
- G2 reviews (865 reviews, 4.6/5 average) flag "Slow Rendering" as a recurring, repeatedly-tagged con, with export jobs reportedly "taking far longer than before" in recent versions ([www.g2.com/products/descript/reviews](https://www.g2.com/products/descript/reviews) via search synthesis) — i.e., real-world sentiment runs counter to the "few seconds" marketing claim above.
- **Streaming partial results**: not documented either way.

### 3.3 Editor / Studio UX

- Core paradigm: **transcript-based/doc-style editing** — delete a word in the transcript and it's removed from the underlying audio/video; cut-and-paste text and the media moves with it ([help.descript.com "Edit like a doc"](https://help.descript.com/hc/en-us/articles/15726742913933-Edit-like-a-doc), corroborated across half a dozen review sites in search results).
- Hybrid with a real timeline: "a multi-track timeline updates in real-time" alongside the transcript view, so users can switch to a conventional visual-editing mode when needed (general search synthesis of multiple Descript reviews).
- **Underlord**: Descript's "agentic video co-editor" — takes plain-language instructions like "remove all filler words," "make this clip two minutes long," "add zooms to hide jump cuts," or "generate a 30-second highlight reel for LinkedIn," and executes them; can combine voice-cloning and AI-avatar tech to write scripts, pick voices, and pair them with avatars ([www.descript.com/](https://www.descript.com/), general search synthesis). Underlord edits can be reverted/rolled back via a dedicated help article, implying some undo-safety net specific to AI-driven edits ([help.descript.com — "Revert or rollback changes made by Underlord (beta)"](https://help.descript.com/hc/en-us/articles/36958274409357-Revert-or-rollback-changes-made-by-Underlord-beta) — title/existence confirmed via search, full content not fetchable).
- Keyboard shortcuts: **Cmd+Z** (undo) / **Shift+Cmd+Z** (redo) on Mac, **Ctrl+Z** / **Ctrl+Shift+Z** on Windows; full shortcut reference lives at help.descript.com's "Keyboard shortcuts" article, organized by feature area, accessible in-app via Help icon → Keyboard Shortcuts (direct fetch of this help page 403'd, but its existence and the undo/redo bindings were confirmed via search results) ([help.descript.com/hc/en-us/articles/10255582172173-Keyboard-shortcuts](https://help.descript.com/hc/en-us/articles/10255582172173-Keyboard-shortcuts)).
- **Autosave confirmed**: "Descript automatically saves your project as you work, so you can always restore a previous version" (general search synthesis).
- Reviews (Capterra: 4.6/5, 183 reviews; G2: 4.6/5, 865 reviews — the two platforms agree closely, a rare consistency in this research) ([www.capterra.com/p/230702/Descript/reviews](https://www.capterra.com/p/230702/Descript/reviews/), [www.g2.com/products/descript/reviews](https://www.g2.com/products/descript/reviews)):
  - Praise: text-based editing "makes editing a breeze"; transcript-linked-to-media workflow "superb."
  - Complaints: **preview/export fidelity and stability bugs** — one reviewer reported "projects edited months earlier appeared as raw recordings later, with missing cuts and effects"; another described "corrupted and failed recordings" with segments randomly dropped ([www.capterra.com/p/230702/Descript/reviews](https://www.capterra.com/p/230702/Descript/reviews/)) — this is a direct, sourced answer to the "does preview match final export" question, and the answer is: not reliably, per user reports.
  - Transcription accuracy complaints on proper nouns, domain vocabulary, and multi-speaker audio ("the transcription engine is rubbish and needs correcting every few lines") ([www.g2.com/products/descript/reviews](https://www.g2.com/products/descript/reviews) via search synthesis).
  - Export flexibility complaint: MP4-only export with 3 fixed quality presets, no manual bitrate control, pushing power users to Premiere for "the final 10%" of their workflow ([www.g2.com/products/descript/reviews](https://www.g2.com/products/descript/reviews) via search synthesis).

### 3.4 B-roll

- Built-in stock library confirmed by name: **Storyblocks and GIPHY** ([help.descript.com/hc/en-us/articles/10165831753997-Stock-media](https://help.descript.com/hc/en-us/articles/10165831753997-Stock-media)) — this is Descript's own help doc, the most authoritative b-roll-provider citation found for any of the four competitors.
- **AI-generated b-roll**: users describe the scene they need ("a bustling city, a quiet park, a cozy office") and Descript's AI generates matching video ([www.descript.com/tools/generative-video-b-roll](https://www.descript.com/tools/generative-video-b-roll)). The specific underlying model/provider is not disclosed on the page.
- Placement/timing is explicitly **manual** — the page instructs users to "fine-tune the timing so each cutaway flows naturally with your main footage. Add transitions, layer in ambient sound or music, and adjust pacing" ([www.descript.com/tools/generative-video-b-roll](https://www.descript.com/tools/generative-video-b-roll)) — i.e., no auto-placement/auto-sync claim, unlike Veed and Captions.ai.
- User-upload support for own b-roll is implied but not explicitly confirmed in the fetched page content ("doesn't replace traditional B-roll — it enhances it").
- Complementary tool: AI Green Screen for background removal/compositing ([www.descript.com/tools/generative-video-b-roll](https://www.descript.com/tools/generative-video-b-roll)).

### 3.5 Captions

- Karaoke-style word-by-word highlighting is confirmed as a named preset, and is referenced in the broader industry as a recognizable "Descript/Karaoke style" — i.e., Descript is credited as having popularized/standardized this caption style (general search synthesis referencing a third-party Premiere plugin built explicitly to mimic "Descript/Karaoke style text").
- Named templates found: Classic, Clean, Karaoke — **exact total preset count not found** despite searching; unlike Captions.ai (100+) or Veed (30+), no source gave Descript a specific caption-style-count number.
- Multi-language dynamic subtitles: **30 languages**, with AI able to adjust voice and mouth movements for translated content (general search synthesis).
- Translation/dubbing: **30+ languages** with lip-sync alignment, spanning "Spanish and Mandarin to Hindi, Turkish, and Swedish" (general search synthesis, e.g. [www.gend.co/blog/descript-multilingual-dubbing-openai-models](https://www.gend.co/blog/descript-multilingual-dubbing-openai-models)). Descript has a documented partnership/case-study relationship with OpenAI specifically on engineering this multilingual dubbing pipeline — an official case study exists at **openai.com/index/descript/** (URL and title confirmed via search; direct WebFetch of the page itself returned 403, so its detailed content could not be independently extracted, but the existence of an OpenAI-Descript multilingual-dubbing case study is corroborated by a second, independent source, [www.gend.co/blog/descript-multilingual-dubbing-openai-models](https://www.gend.co/blog/descript-multilingual-dubbing-openai-models)).
- **Overdub** (voice cloning): flagship feature, now bundled on **all paid plans** as of a specific product announcement ([www.descript.com/blog/article/overdub-on-all-plans](https://www.descript.com/blog/article/overdub-on-all-plans)). "Overdub 3.0" can build a voice clone from just **3 minutes** of training audio, and adds emotional-intonation control (whisper/shout/excited tones) (general search synthesis). If a speaker misspeaks a name or date, the creator can simply retype the correct text and Descript regenerates that word in the cloned voice.
- Emoji auto-insertion: **not confirmed** — no source discussed this for Descript.

### 3.6 Differentiators

- Homepage tagline: **"AI-editing for every kind of video"**; core pitch: "Direct your AI co-editor to do your video editing for you, or do it yourself with intuitive editing tools"; "video editing is as easy as typing" ([www.descript.com/](https://www.descript.com/)).
- The two named signature features that define Descript's identity in virtually every comparison found: **Underlord** (agentic AI co-editor / natural-language editing) and **Overdub** (voice cloning) ([www.descript.com/](https://www.descript.com/), [www.descript.com/blog/article/overdub-on-all-plans](https://www.descript.com/blog/article/overdub-on-all-plans)).
- Positioning: accessibility ("as easy as using docs and slides"), no need for "pricey mics or soundproofing" (AI cleans up audio), content-repurposing use case explicitly marketed ("produce 10+ clips from a single interview"), and a customer case study claiming "increased content production by 100%" ([www.descript.com/](https://www.descript.com/)).
- In head-to-head comparisons, Descript is consistently framed as the pick for **dialogue-heavy content** (podcasts, interviews, talking-head video) where transcript-editing saves the most time, vs. CapCut for fast visual/trend-driven short-form and Veed for team/brand workflows ([www.vmaker.com/blog/descript-vs-capcut-for-ai-video-editing](https://www.vmaker.com/blog/descript-vs-capcut-for-ai-video-editing/), [www.fahimai.com/capcut-vs-descript](https://www.fahimai.com/capcut-vs-descript)).

---

## 4. CapCut (web app, ByteDance/Lark)

### 4.1 Pricing (2026) — CapCut publishes no single authoritative price list; regional/channel variance is itself a documented fact

Direct WebFetch of **capcut.com/pricing returned a 404** — CapCut does not appear to host a conventional static pricing page at that URL, consistent with multiple aggregator sites' own disclaimer that "CapCut doesn't publish official prices... confirm the figure on the in-app Upgrade screen for your region" ([www.eesel.ai/blog/capcut-pricing](https://www.eesel.ai/blog/capcut-pricing), [checkthat.ai/brands/capcut/pricing](https://checkthat.ai/brands/capcut/pricing)).

That said, the following structure was **consistent across five+ independent aggregators** (gamsgo, eesel.ai, bigvu.tv, socialrails, fluxnote, checkthat.ai), which is a much stronger cross-check than Veed received:

| Tier | Price | Notes |
|---|---|---|
| Free | $0 | Basic editing, 1080p export; a watermark is added **only** if the export uses a Pro-tagged template/effect/AI feature — a plain manual export carries no watermark ([bigvu.tv/blog/capcut-pricing-2026-free-vs-pro-included-alternatives](https://bigvu.tv/blog/capcut-pricing-2026-free-vs-pro-included-alternatives/)) |
| Standard (formerly called "Pro" before the 2026 restructure) | ~$9.99/mo | Removes watermark, more templates/transitions/effects, no 4K ([www.eesel.ai/blog/capcut-pricing](https://www.eesel.ai/blog/capcut-pricing), [bigvu.tv](https://bigvu.tv/blog/capcut-pricing-2026-free-vs-pro-included-alternatives/)) |
| Pro (new tier introduced in the 2026 restructure) | $19.99/mo or $179.99/yr via the web checkout | Up from the old $9.99/mo ($77.99/yr) Pro pricing; 4K export, full AI toolkit (auto captions, background removal, camera tracking, vocal isolation, speaker-ID captions, AI voice effects), 100GB+ cloud storage, 12M+ royalty-free assets, reportedly ~1,200 AI points/month ([fluxnote.io/guides/capcut-pro-pricing-2026](https://fluxnote.io/guides/capcut-pro-pricing-2026), [bigvu.tv](https://bigvu.tv/blog/capcut-pricing-2026-free-vs-pro-included-alternatives/)) |
| Team | $24.99/mo per user | Collaboration features ([socialrails.com/blog/capcut-pricing-guide](https://socialrails.com/blog/capcut-pricing-guide), [www.eesel.ai/blog/capcut-pricing](https://www.eesel.ai/blog/capcut-pricing)) |

**Regional/channel variance is large and explicitly documented**: mobile App Store pricing runs $13.99-19.99/mo for the same Pro tier that costs $7.99-9.99/mo direct from CapCut's own website — i.e., buying via the web can be **~20-30% to 2x cheaper** than buying via iOS/Google Play ([bigvu.tv/blog/capcut-pricing-2026-free-vs-pro-included-alternatives](https://bigvu.tv/blog/capcut-pricing-2026-free-vs-pro-included-alternatives/), [socialrails.com/blog/capcut-pricing-guide](https://socialrails.com/blog/capcut-pricing-guide)). Regional pricing also means users in Brazil, India, and Southeast Asia pay significantly less than North America/Europe ([www.gamsgo.com/blog/capcut-pricing](https://www.gamsgo.com/blog/capcut-pricing)). Annual billing runs ~$74.99-89.99/yr, a 22-27% discount vs. monthly ([socialrails.com/blog/capcut-pricing-guide](https://socialrails.com/blog/capcut-pricing-guide)).

### 4.2 Processing speed

- Auto-caption generation is claimed at **"often under 30 seconds for a 10-minute video,"** attributed to ByteDance's in-house speech-recognition technology — and this number holds up under cross-check: the independent Veed-vs-CapCut head-to-head separately measured CapCut captions finishing in "under 30 seconds" vs. Veed's 30-90 seconds for the same length ([flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization](https://flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization/)).
- AutoCut / long-to-short clipping handles source videos up to **3 hours or 10GB** ([www.capcut.com/resource/top-7-autocut-solutions-for-social-media](https://www.capcut.com/resource/top-7-autocut-solutions-for-social-media)).
- Scene-transition/highlight-detection accuracy is cited at **"about 75% of the time"** for major scene transitions, with the same source noting it "struggles with dialogue-based content shifts and subtle emotional moments" ([www.opus.pro/blog/veed-vs-capcut](https://www.opus.pro/blog/veed-vs-capcut)) — a rare specific accuracy percentage among all the sources checked for any of the 4 tools.
- No specific "1-hour video end-to-end" processing time claim was found on CapCut's own site.
- **Streaming partial results**: not documented either way in official resources. One technical/community observation suggests CapCut's exports are "not fully processing from the original file... it's a mix of original file plus processed caches," which may explain a perception of speed but doesn't confirm progressive/partial clip generation ([community threads via search synthesis](https://www.capeditcut.com/community/capcut/slow-render-export-in-premiere-elements)).
- Real-world complaints: rendering time depends heavily on clip length/resolution/device; occasional lag, freezes, and crashes during long editing sessions on more demanding projects ([www.vmaker.com/blog/descript-vs-capcut-for-ai-video-editing](https://www.vmaker.com/blog/descript-vs-capcut-for-ai-video-editing/)).

### 4.3 Editor / Studio UX

- Mobile-first design language: swipe gestures, pinch-to-zoom on mobile; desktop version uses a more conventional timeline with keyframes and J/K/L-style playback ([www.opus.pro/blog/veed-vs-capcut](https://www.opus.pro/blog/veed-vs-capcut), corroborated by third-party keyboard-shortcut cheat sheets referencing "keyframes," "split keys," "zoom controls").
- Keyboard shortcuts are documented **in-app** (Help menu → Shortcut) rather than via a public web doc; multiple third-party cheat sheets (Skillademia, HotKeyGuru, DefKey, TutorialTactic) list roughly **50 shortcuts** covering timeline splitting, deleting, compound-clip management, keyframes, and frame-by-frame navigation ([www.skillademia.com/shortcuts/capcut-shortcuts](https://www.skillademia.com/shortcuts/capcut-shortcuts), [tutorialtactic.com/blog/capcut-shortcuts](https://tutorialtactic.com/blog/capcut-shortcuts/)).
- Offline editing is available after the app is downloaded (mobile/desktop) — a specific advantage over Veed's browser-only model ([www.opus.pro/blog/veed-vs-capcut](https://www.opus.pro/blog/veed-vs-capcut)).
- **B-roll insertion is manual**, not automatic — this is a meaningful, well-sourced differentiator vs. Veed and Captions.ai (see 4.4).
- Undo/redo and multi-select/batch-editing specifics were **not separately documented** beyond the general shortcut cheat sheets referenced above (no dedicated help article found stating explicit keybindings the way Veed's and Descript's were).
- Direct reliability complaints: occasional lag, temporary freezes, and crashes during extended editing sessions, per a head-to-head with Descript ([www.vmaker.com/blog/descript-vs-capcut-for-ai-video-editing](https://www.vmaker.com/blog/descript-vs-capcut-for-ai-video-editing/)).

### 4.4 B-roll

- **Manual insertion is the primary model** — this directly contrasts with Veed and Captions.ai, both of which default to automatic, transcript-driven b-roll placement. CapCut's own resource article instructs users to click "Stock materials," search by keyword, and then "drag the polished B-roll clips to the appropriate points in the timeline where you want them to appear" — an explicitly manual workflow ([www.capcut.com/resource/what-is-a-b-roll](https://www.capcut.com/resource/what-is-a-b-roll)).
- Built-in stock library exists ("a wide range of stock B-rolls... without watermarks"), but CapCut's own content does not name specific licensed integration partners.
- **No AI-generated b-roll** confirmed within the core CapCut editor (the b-roll-specific resource article makes no mention of it), though CapCut does have separate, unrelated AI image/video generator tools elsewhere in the product that are not integrated into this b-roll workflow per the fetched content.
- Users **can** upload their own b-roll via Import ([www.capcut.com/resource/what-is-a-b-roll](https://www.capcut.com/resource/what-is-a-b-roll)).
- Notably, CapCut's **own** blog content recommends **10 external, competing stock-footage sites** for sourcing b-roll to then import into CapCut: Artlist, Pixabay, VideoHive, Dissolve, Shutterstock, Videvo, Storyblocks, Video Copilot, Bigstock, and Videezy ([www.capcut.com/resource/what-is-a-b-roll](https://www.capcut.com/resource/what-is-a-b-roll)) — i.e., CapCut is implicitly acknowledging it doesn't have a comprehensive in-house library comparable to Storyblocks/Envato, unlike Descript (which names Storyblocks/GIPHY as built-in) or Veed (built-in stock + AI-auto-place).

### 4.5 Captions

- Named caption template styles found: **Glow, Trending, Aesthetic, Multiline** ([www.capcut.com/resource/caption-template](https://www.capcut.com/resource/caption-template), [crepal.ai/blog/aivideo/blog-ai-text-captions-capcut-guide](https://crepal.ai/blog/aivideo/blog-ai-text-captions-capcut-guide/)). A "Style captions with AI" button on CapCut Web auto-applies one of these trending templates.
- Animation styles confirmed in a head-to-head: **"bounce, shake, glow"** word-by-word animation, plus **emoji integration** ([flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization](https://flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization/)) — this is a direct, sourced confirmation of CapCut emoji support in captions.
- **Exact total preset count not found** despite dedicated searching — aggregators only say "dozens" or "a wide range," no official number surfaced, and this appears to be a genuine gap in CapCut's public documentation (or the number is simply not publicized).
- Language-count claims **conflict across sources**: one describes CapCut's auto-caption feature as generating subtitles "in more than 20 languages" ([www.vidio.ai](https://www.vidio.ai/blog/article/is-there-a-way-to-auto-translate-and-retime-captions-for-multiple-languages-in-capcut)); the direct Veed head-to-head instead states CapCut supports **"approximately 40 languages"** for translation, albeit "with limited customization" vs. Veed's 130+ ([flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization](https://flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization/)). Both cited; genuinely unresolved which is current/accurate.
- AI Dubbing: translates audio and adjusts the speaker's mouth movements for lip-sync naturalness, across languages including **English, Bengali, Malay, Chinese**, and more ([www.capcut.com/tools/ai-dubbing](https://www.capcut.com/tools/ai-dubbing)).
- Bilingual/dual-language captions supported (original + translated shown together) ([www.capcut.com/resource/translated-subtitles](https://www.capcut.com/resource/translated-subtitles)).
- Transcription-accuracy benchmark (same 5-language flowith.io test cited under Veed above): CapCut **beat** Veed on Mandarin (5.9% WER vs. Veed's 8.1%) but **lost** on Spanish (7.2% vs. Veed's 6.8%) — i.e., CapCut appears stronger on Asian languages, Veed stronger on European languages, per this one benchmark ([flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization](https://flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization/)).

### 4.6 Differentiators

- Homepage tagline: **"AI-Powered Photo & Video Editor for Everyone"**; headline: "CapCut has everything you need to create trending content for YouTube, Instagram, and beyond" ([www.capcut.com/](https://www.capcut.com/)).
- Stats claimed directly on the homepage: **100M+ downloads, 100K+ creators, 4.7 App Store rating, 20 languages** (UI localization, not caption languages), and **873K+ creative templates** available ([www.capcut.com/](https://www.capcut.com/)). A separate comparison piece cites **1 billion+ Android downloads** as of Q3 2024 ([www.opus.pro/blog/veed-vs-capcut](https://www.opus.pro/blog/veed-vs-capcut)) — the 100M+ (homepage) vs. 1B+ (Android-specific, per a third party) figures aren't necessarily contradictory (global downloads vs. Android-only), but are worth noting as very different scales depending on which figure gets quoted.
- Core positioning: **free, all-in-one, AI-powered, no-watermark, multi-platform** (desktop/online/pad/mobile) ([www.capcut.com/](https://www.capcut.com/)).
- ByteDance/Lark backing gives CapCut access to internal, TikTok-grade speech-recognition technology, repeatedly cited as the reason for its caption-generation speed advantage ([flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization](https://flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization/)).
- In head-to-head content, CapCut is consistently positioned as the **mobile-first, trend-driven, free-to-start** option for quick social content, vs. Veed's team/brand focus and Descript's dialogue/podcast focus ([www.opus.pro/blog/veed-vs-capcut](https://www.opus.pro/blog/veed-vs-capcut), [www.vmaker.com/blog/descript-vs-capcut-for-ai-video-editing](https://www.vmaker.com/blog/descript-vs-capcut-for-ai-video-editing/)).

---

## Summary of cross-checked numeric claims (2+ independent sources)

| Claim | Value | Sources agreeing |
|---|---|---|
| Descript pricing (all 4 paid tiers, monthly & annual) | Free/$0, Hobbyist $24→$16, Creator $35→$24, Business $65→$50 | Official [descript.com/pricing](https://www.descript.com/pricing) + independent general web-search synthesis of Tekpon/Sonix/G2/layer3labs — matched exactly |
| Veed 10-min auto-caption processing time | 30-90 seconds | [flowith.io](https://flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization/) + general search synthesis |
| CapCut 10-min auto-caption processing time | Under 30 seconds | [flowith.io](https://flowith.io/blog/veed-io-vs-capcut-which-better-ai-subtitles-localization/) + general search synthesis |
| Captions.ai 100+ caption styles | 100+ | [captions.ai/features](https://captions.ai/features) + [eesel.ai](https://www.eesel.ai/blog/captions-ai) |
| Captions.ai Max tier | $24.99/mo, 500 credits | Official pricing page + official help doc, matched |
| CapCut Pro restructure | ~$9.99→$19.99/mo (2x) | 4+ independent aggregators (gamsgo, eesel, bigvu, fluxnote) |
| Descript ratings | 4.6/5 | G2 (865 reviews) and Capterra (183 reviews) — independently matched |

## Notable unresolved discrepancies (flagging per instructions)

1. **Veed pricing** — five sources gave five different tier-name/price combinations for the paid tiers (see 2.1). Could not resolve; official pricing page is JS-rendered and unfetchable statically.
2. **Veed vs. CapCut translation-language counts** — CapCut cited at both "20+" and "~40" languages depending on source (see 4.5).
3. **Captions.ai review ratings** — 4/5 (289 reviews, Trustpilot) vs. 1.6/5 (54 reviews, per a competitor's comparison page) (see 1.3).
4. **Captions.ai b-roll existence** — one comparison claims "no B-roll functionality" while Captions' own help center documents a full three-source b-roll system (see 1.3/1.4).
5. **CapCut download stats** — 100M+ (homepage, likely global/all-platform) vs. 1B+ (Android-only, per third party) (see 4.6).

## Data points searched for but NOT found

- Any of the four companies' exact "1-hour source video takes X minutes end-to-end" marketing or documented claim — none publish this specific benchmark.
- Whether **any** of the four tools streams/shows partial clip results before a full source video finishes processing (moment-detection/AI-clips features) — undocumented for all four despite targeted searching on Veed Clips, CapCut AutoCut, and Captions.ai AI Shorts.
- An official, current, static Veed.io pricing table (page is client-rendered; every fetch attempt against veed.io/pricing, G2, and TrustRadius's Veed pricing pages failed to return the actual numbers).
- CapCut's own official pricing page content (capcut.com/pricing returned HTTP 404 on direct fetch).
- Exact total caption-preset counts for Descript and CapCut (Captions.ai's 100+ and Veed's 30+ were findable; Descript and CapCut were not, likely because neither publishes a specific count).
- Emoji auto-insertion confirmation for Captions.ai and Descript specifically (confirmed only for Veed and CapCut).
- Descript's exact Underlord/multilingual-dubbing technical details from the OpenAI case study page itself (openai.com/index/descript/ returned HTTP 403 on direct fetch; only corroborated indirectly via a second source).
