# AI model options

This page records what Narriflow uses for each AI job and which other models are worth testing before switching. All prices are USD per 1M tokens (input / cached input / output), read from each provider's official pricing page on **2026-11-13**. Prices change often, so check again before switching.

Evidence comes from two places:
- **Our own tests,** where we have them (scripts and data are listed in [Sources](#sources)).
- **Named public leaderboards,** where we don't. No public benchmark measures viral clip picking or precision filler tagging, so for those jobs the deciding test is our own.

## In production

| Job | Model | Where |
|---|---|---|
| Clip selection | `gpt-6-luna`, medium reasoning | `packages/services/src/clip-selection-runtime.ts` |
| Clip titles, social copy, content suite, dubbing translation | `gpt-6-luna`, no reasoning | `OPENAI_TEXT_MODEL` in `packages/services/src/openai-models.ts` |
| Filler words (non-English) | `gpt-6-luna`, no reasoning, alone | `FILLER_TAGGING_MODELS` in `packages/services/src/clip-filler-tagging.ts` |
| Speech-to-text | ElevenLabs `scribe_v3`; Urdu and unknown-language audio on `scribe_v2` | `scribeModelForLanguage` in `packages/validators/src/language.ts`; [ADR 0018](adr/0018-elevenlabs-scribe-transcription.md) |
| Dubbing voice | `gpt-4o-mini-tts` (**shuts down 2027-01-06**) | `packages/services/src/dubbing.service.ts` |
| Studio AI images (text-free B-roll) | `gpt-image-2`, medium (**shuts down 2027-02-10**) | `OPENAI_IMAGE_MODEL` / `OPENAI_IMAGE_QUALITY` Worker secrets; `apps/media/src/openai-image-provider.ts` |
| Library search | `text-embedding-3-small` | `packages/services/src/openai-embedding-provider.ts` |

`gpt-6-luna` costs $0.10 / $0.01 / $0.50. gpt-5.4-mini cost $0.75 / $0.075 / $4.50.

Two behaviours to know:
- **Reasoning default.** `gpt-6-luna` defaults to *medium* reasoning, whereas gpt-5.4-mini defaulted to none (measured 2026-11-13). Every job that relied on that default now sends `reasoning: { effort: "none" }` explicitly.
- **Overrides.** The environment variables `OPENAI_CLIP_MODEL`, `OPENAI_CONTENT_MODEL`, `OPENAI_ASSISTED_COPY_MODEL` and `OPENAI_DUB_TRANSLATION_MODEL` override the model per job. None are set on the deployed Worker.

## Deadlines

- **Dubbing voice by 2027-01-06.** `gpt-4o-mini-tts` shuts down then. OpenAI's suggested replacement is a Realtime-API workflow, not a drop-in for `/audio/speech`. See [Dubbing voice](#dubbing-voice-tts).
- **Studio AI images by 2027-02-10.** `gpt-image-2` shuts down then. See [Studio AI images](#studio-ai-images).
- **Promotional prices end.**
  - Gemini 4 Argon and Carbon double on 2026-12-01.
  - Gemini 3.8 Flash and the Gemini 3.8 TTS models double on 2027-01-01. After that, 3.8 Flash costs $1.50 / $7.50.

## Options to test, by job

### Clip selection

Run a blind A/B on our own videos: the same transcripts and windows for every model, with 2–3 raters judging the top clips. Rate hook strength, story completeness, start and end points, variety, and how faithfully each pick matches the transcript.

| Model | Price | Why test it | Watch out for |
|---|---|---|---|
| `gemini-3.8-flash` (low/medium thinking) | 0.75 / 0.075 / 3.75 until 2026-12-31, then 1.50 / 0.15 / 7.50 | Best cheap creative score: LMArena creative writing 1488 (2026-11-11). Best indirect Hindi/Urdu evidence. | Needs a Gemini key and adapter; the price doubles |
| `claude-haiku-5-5` (medium) | 0.10 / 0.01 / 0.50 up to 100K-token prompts, 5× above | Most intelligence per dollar on Artificial Analysis (36 at $0.077 blended) | Weaker creative writing (Arena 1361). Our 30-minute windows stay under 100K tokens. |
| `gpt-6.1-terra` (low/medium) | 1.00 / 0.05 / 5.00 | OpenAI's quality step above Luna (Artificial Analysis: medium 38, low 29) | 10× Luna's price |
| `muse-ember-1.0` (Meta) | 0.10 / 0.004 / 0.50 | Strict schema, up to 524K output tokens, no training on Standard | Released 2026-11-09; editorial quality unverified |

### Titles, hooks, social posts, content suite

Run a blind preference test in Hindi, Urdu and English. Also check that copy stays grounded in the transcript: no invented quotes or claims.

| Model | Price | Why test it | Watch out for |
|---|---|---|---|
| `gpt-6-luna`, low reasoning | as above | Same model; checks whether a little reasoning improves copy | Raise the output budgets |
| `gemini-3.8-flash` | as above | Strongest cheap creative writing | The price doubles |
| `gemini-4-argon` | 2.00 / 0.10 / 10.00 until 2026-11-30, then 4.00 / 0.20 / 20.00 | Creative-writing leader (Arena 1523); use as a quality reference | Too expensive as a default |
| `claude-sonnet-5-5` | 2.00 / 0.10 / 10.00 | Strong editor and style reference (creative 1464) | 20× Luna's price |

### Dubbing translation

Bilingual reviewers should check meaning, names, numbers, negation, tone and script, and whether Hinglish and Roman Urdu are kept. No current English↔Hindi/Urdu translation leaderboard exists.

| Model | Price | Why test it |
|---|---|---|
| `gemini-3.5-flash-lite` | 0.30 / 0.03 / 2.50 | Google positions it for translation. Gemini leads the indirect Hindi/Urdu evidence: WMT26 human rank, UrduMMLU 90.2%, the Artificial Analysis Hindi index. |
| `gemini-3.8-flash` | as above | Stronger language generation, at a higher price |

### Dubbing voice (TTS)

Researched again on 2026-11-13. Three research passes (two Claude, one Sol) reached the same shortlist.

**How we call it today.**
- Each clip's translated script goes to OpenAI `/v1/audio/speech` in one POST and comes back as MP3. A clip runs up to 180 s, which is about 2,700 characters.
- The user picks one of six OpenAI voices.
- Cost is about $0.9 per generated hour.

**OpenAI has no plain-HTTP replacement.**
- Its named successor, `gpt-realtime-2.1-mini`, works only over Realtime (WebSocket, WebRTC or SIP), and OpenAI says it is not supported on `/v1/audio/speech`.
- The only HTTP route left is `gpt-audio-1.5` via chat completions, at $64 per 1M audio tokens (≈ $4.6/hour, but OpenAI doesn't publish its tokens per minute).
- Staying with OpenAI therefore means a new integration anyway.

**What the evidence says about quality.**
- The Artificial Analysis Speech Arena is English-only.
- The best Hindi/Urdu evidence is SpeechArenaBench ([Interspeech 2026](https://arxiv.org/html/2604.21481v1)). It used 1,915 native raters across 10 Indic languages, including Hindi and Urdu, and included code-mixed sentences.
  - Scores: Gemini 2.5 Pro TTS 1129, Eleven v3 1056, Cartesia Sonic 3 1051, Sarvam Bulbul v3 1022, MiniMax Speech 2.8 HD 994, **`gpt-4o-mini-tts` 943**.
  - So the current voice is weak for our most important languages, and the switch is a chance to improve quality.
- No public benchmark compares today's models on Urdu.
- Our round trip (2026-11-13): an Urdu and a Hindi script with names, numbers and English words went through `gpt-4o-mini-tts` and back through Scribe v2. Scribe recovered almost every word: one Urdu word was misheard, and Hindi had none. Any replacement must at least match that.

Hourly prices assume 15 characters per second (54,000 characters per hour).

| Model | Price | Per generated hour | Speech Arena (AA, English) | Hindi / Urdu | Fit with our call |
|---|---|---|---|---|---|
| **Inworld `inworld-tts-2`** | $25 per 1M chars | $1.35 (≈ $0.07 per 180 s clip) | 1268 | Yes / yes ("Tier 2": supported, quality varies) | **Near drop-in:** an OpenAI-compatible `POST /v1/audio/speech` returns MP3, up to 4,000 characters per request. Supports voice cloning. |
| Inworld `inworld-tts-2-flash` | $15 per 1M chars | $0.81 | 1215 | Yes / yes | Same endpoint. Ignores style instructions. |
| Speechify Simba 3.5 | $15 per 1M chars list ($10 launch price until 2026-11-21) | $0.54–0.81 | 1294 | Yes / yes | HTTP. The plain endpoint takes 2,000 characters; the streaming endpoint takes 20,000. **Its API no-training and retention terms could not be verified.** |
| Cartesia Sonic 3.6 | Plan-based | ≈ $2.0–2.7 | 1294 | Yes / yes (Urdu new in 3.6); documents Hinglish and Roman Hindi | One HTTP POST returns MP3. **Its terms allow training on inputs unless you opt out.** |
| ElevenLabs `eleven_v4` | $80 per 1M chars | $4.32 | 1340 (top) | Yes / yes | HTTP through the Text to Dialogue API, up to 10,000 characters. `eleven_v4_turbo` ($2.16/hour) is WebSocket only. |

Ruled out as a single default:
- **No Urdu:** Gemini 3.8 TTS (Urdu is not in its language table; it also outputs WAV only, and its price doubles on 2027-01-01), ElevenLabs Flash and Multilingual v2, Sarvam Bulbul, xAI TTS, and MiniMax.
- **Low quality:** Azure Neural has `ur-PK` voices and costs $0.81/hour, but scores only 1032.
- **Discontinued:** Hume's TTS.
- **Separate feature:** ElevenLabs **Dubbing** keeps the original speaker's voice. It costs $2.20 per minute (v2 alpha, $132/hour). Treat it as a premium feature, not a voice replacement.

**Next step.** Audition Inworld TTS-2, Simba 3.5, Sonic 3.6 and Eleven v4 on the same scripts:
- native Hindi, Urdu script, Roman Urdu, and Hindi-English and Urdu-English switching;
- names, `Rs 1,250`, phone numbers, dates and times.

Use blind native Hindi and Pakistani-Urdu listeners, and also run the Scribe round trip to catch dropped words. Our ElevenLabs key is limited to speech-to-text, so it needs the `text_to_speech` permission before Eleven can be tested.

### Studio AI images

Researched again on 2026-11-13.
- **What it does today:** the Studio's generated-images panel makes text-free B-roll in four styles (editorial, cinematic, photoreal, illustration) at 1024×1536, 1536×1024 or 1024×1024.
- **What OpenAI recommends:** its deprecation page names `gpt-image-2.6-flare` or `-sunburst` as the replacement for `gpt-image-2`.

The "Measured" rows are real calls on 2026-11-13: the same prompt, medium quality, at 1024×1536. Their cost comes from the billed `usage`. The images are in `.scratch/model-selection-2026-11/images/`.

| Model | $ per image | Time | LMArena text-to-image (2026-11-12) | Notes |
|---|---|---|---|---|
| `gpt-image-2` medium (current) | **$0.041** measured (1,372 output tokens) | 61 s | 1382 | Shuts down 2027-02-10 |
| **`gpt-image-2.6-flare` medium** | **$0.034** measured (1,132 tokens) | **10 s** | 1384 | **Change only the `OPENAI_IMAGE_MODEL` secret.** OpenAI's named successor. It has a new `complexity` field, which defaults to high. |
| `gpt-image-2.5-flare` medium | **$0.0105** measured (343 tokens) | 13 s | 1398 (preliminary) | A quarter of today's price, and its image was as usable as the others. It's an older family that isn't scheduled for shutdown yet, so expect another migration later. |
| `gpt-image-2.6-sunburst` | ≈ $0.041 high, $0.074 xhigh | — | 1406 (medium) | Premium reference. Artificial Analysis leader (1261 at max). |
| `gemini-nano-banana-2.1` | $0.0336 at 1K ($0.0168 batch) | — | 1327 (AA 1176) | Needs a Gemini adapter. Paid tier doesn't train on our data. |
| Seedream 5.5 (ByteDance) | ≈ $0.02–0.03 | — | AA 1134 | Needs an adapter. Check BytePlus data terms. |
| Meta Muse Image | $0.01 | — | 1266 (AA 1127) | Cheapest strong option. Its Standard mode doesn't train on our data. It doesn't guarantee exact output sizes. |

Avoid or skip:
- **Black Forest Labs FLUX:** its API terms allow training on inputs and outputs.
- **Midjourney:** no official API.
- **Imagen 4:** shut down.
- **`gpt-image-1-mini` and `gpt-image-1.5`:** shut down 2026-12-01.

**Recommendation.** Switch `OPENAI_IMAGE_MODEL` to `gpt-image-2.6-flare`. It is a one-secret change: 17% cheaper, about 6× faster in our test, and the same quality on the leaderboard. Audition `gpt-image-2.5-flare` and Muse Image on 24–40 real prompts if cost per image matters more, and score cost per accepted image.

### Filler words

Run the existing harness (see [Sources](#sources)). A candidate must make 0 wrong tags on FLEURS and add no real word on Nyra before it can replace or join `gpt-6-luna`.

Measured 2026-11-13, production prompt and guards:

| Setup | Wrong tags (FLEURS, 102 languages) | Nyra recall | $ per 1M words |
|---|---|---|---|
| **`gpt-6-luna` none (production), two runs** | 0, 0 | 87.7%, 86.7% | 0.92 |
| `gpt-6-luna` low | 0 | 82.7% | 1.12 |
| `gpt-6.1-terra` none | 0 | 82.1% | 9.05 |
| Previous pair: `gpt-5.6-luna` low AND `gpt-5.4` none | 0 | 81.6% | 28.05 |

Not yet tested; each needs its provider's key:
- **`claude-haiku-5-5`** is the best candidate for a second, independent voter (all models must agree).
- **`glm-5.3-flash` on Fireworks** costs 0.15 / 0.03 / 0.50 and enforces the schema.

### Speech-to-text

| Model | Price per audio hour | Notes |
|---|---|---|
| xAI `grok-voice-transcribe-2.0` | $0.10 (REST) | Half the price. Artificial Analysis WER 2.3% (Scribe v3: 1.9%). Lists Hindi and Urdu. Check Urdu script, diarization and whether fillers are kept. |
| `gemini-3.5-transcribe` | ≈ $0.30 | Independent comparison point. Truncates past 30 minutes when diarization or word timestamps are on. |

### Library search embeddings

The current model costs about $0.0003 per video hour, so switch only for better search results. Test with Roman Urdu queries against Urdu-script transcripts, and English queries against non-English clips.

| Model | Price per 1M tokens | Evidence |
|---|---|---|
| `gemini-embedding-2` | $0.20 ($0.10 batch) | Multilingual MTEB 69.9 (paper, 2026-05-26) |
| `text-embedding-3-large` | $0.13 | MIRACL 54.9 vs small's 44.0 (OpenAI, 2024) |
| Qwen3-Embedding-8B / Microsoft Harrier OSS 27B | Hosted price unverified | Top of multilingual MTEB (70.58 / 74.27); open weights |

## Providers to avoid for our data

| Provider (first-party API) | Problem |
|---|---|
| DeepSeek | Data stored in China; user input listed as training data |
| Moonshot (Kimi) | Trains on inputs by default |
| MiniMax | Policy unverified |

Use these open models only through a host with no retention or training on API data: Fireworks, Groq, Together or DeepInfra.

These are fine: OpenAI, Anthropic, Gemini paid tier ("Used to improve our products: No"), and Meta Standard.

Groq does not stream strict structured output. Filler tagging needs streaming, because a Worker holds only six connections waiting for headers.

## Coding benchmarks

DeepSWE and CursorBench rank the same model very differently. For example, gpt-5.6-luna is a top value pick on DeepSWE and near the bottom of CursorBench. Neither measures our jobs, so neither is used here.

## Sources

**Provider pricing pages:**
- [OpenAI](https://developers.openai.com/api/docs/pricing)
- [Anthropic](https://claude.com/pricing#api)
- [Gemini](https://aistudio.google.com/docs/pricing)
- [xAI](https://docs.x.ai/developers/models)
- [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/)
- [ElevenLabs](https://elevenlabs.io/pricing/api)
- [Inworld](https://inworld.ai/pricing), with its [OpenAI-compatible speech endpoint](https://docs.inworld.ai/tts/openai-compatibility.md)
- [Speechify](https://speechify.ai/pricing)
- [Cartesia](https://cartesia.ai/pricing)
- [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)

**Leaderboards:**
- [Artificial Analysis](https://artificialanalysis.ai/models)
- [LMArena](https://arena.ai/leaderboard), including [text-to-image](https://arena.ai/leaderboard/text-to-image)
- [Artificial Analysis Speech Arena](https://artificialanalysis.ai/text-to-speech/leaderboard)
- [SpeechArenaBench](https://arxiv.org/html/2604.21481v1) (Interspeech 2026: native-rater Indic TTS preferences)
- [OpenRouter](https://openrouter.ai/models)
- [DeepSWE](https://deepswe.datacurve.ai/)
- [CursorBench](https://cursor.com/cursorbench)

**Our own data:**
- The full research notes are in `.scratch/model-selection-2026-11/report.md`.
- The filler-test harness is in `.scratch/model-selection-2026-11/filler-eval/`; its README explains how to rebuild the datasets.
