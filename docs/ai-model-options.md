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
| Thumbnails | `gpt-image-2`, medium (**shuts down 2027-02-10**) | `OPENAI_IMAGE_MODEL` |
| Library search | `text-embedding-3-small` | `packages/services/src/openai-embedding-provider.ts` |

`gpt-6-luna` costs $0.10 / $0.01 / $0.50. gpt-5.4-mini cost $0.75 / $0.075 / $4.50.

Two behaviours to know:
- **Reasoning default.** `gpt-6-luna` defaults to *medium* reasoning, whereas gpt-5.4-mini defaulted to none (measured 2026-11-13). Every job that relied on that default now sends `reasoning: { effort: "none" }` explicitly.
- **Overrides.** The environment variables `OPENAI_CLIP_MODEL`, `OPENAI_CONTENT_MODEL`, `OPENAI_ASSISTED_COPY_MODEL` and `OPENAI_DUB_TRANSLATION_MODEL` override the model per job. None are set on the deployed Worker.

## Deadlines

- **Dubbing voice by 2027-01-06.** `gpt-4o-mini-tts` shuts down then. OpenAI's suggested replacement is a Realtime-API workflow, not a drop-in for `/audio/speech`. See [Dubbing voice](#dubbing-voice-tts).
- **Thumbnails by 2027-02-10.** `gpt-image-2` shuts down then. See [Thumbnails](#thumbnails).
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

Audition each model on Hindi, Urdu, Roman Urdu, names, numbers and mixed English. Supported-language counts don't guarantee pronunciation.

| Model | Price | Est. per generated hour | Voice Arena (Artificial Analysis) | Notes |
|---|---|---|---|---|
| `gemini-3.8-flash-lite-tts` | $0.50 text in, $6 audio out per 1M (≈ $0.0015 per 10 s) until 2026-12-31, then double | ≈ $0.55 | 1260 | Cheapest good option. Outputs WAV by default, so convert to MP3. |
| `gemini-3.8-flash-tts` | $0.50 text in, $9 audio out per 1M (≈ $0.00225 per 10 s) until 2026-12-31, then double | ≈ $0.82 | 1284 | More expressive |
| ElevenLabs `eleven_v4_turbo` | $40 per 1M characters | ≈ $2.16 | 1339 | Top quality. We already have an ElevenLabs account. It runs over the Text to Dialogue WebSocket; plain HTTP is `eleven_v4` at $80 per 1M characters. |

### Thumbnails

Use the same source photo, text and aspect ratio for every model, and count how many attempts each needs before an image is usable.

| Model | Price | Image Arena | Notes |
|---|---|---|---|
| `gpt-image-2.6-flare`, medium | text in 5, image in 8, image out 30 per 1M | 1383 (current `gpt-image-2` medium scores 1382) | Same API: the easiest migration |
| `gemini-nano-banana-2.1` | image out $30 per 1M ≈ $0.034 per image | 1328 | Cheaper; batch halves it |
| `gpt-image-2.6-sunburst` | same rates as Flare | Artificial Analysis leader (1262 on its scale) | Premium reference |

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

**Leaderboards:**
- [Artificial Analysis](https://artificialanalysis.ai/models)
- [LMArena](https://arena.ai/leaderboard)
- [OpenRouter](https://openrouter.ai/models)
- [DeepSWE](https://deepswe.datacurve.ai/)
- [CursorBench](https://cursor.com/cursorbench)

**Our own data:**
- The full research notes are in `.scratch/model-selection-2026-11/report.md`.
- The filler-test harness is in `.scratch/model-selection-2026-11/filler-eval/`; its README explains how to rebuild the datasets.
