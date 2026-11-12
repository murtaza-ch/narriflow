# AI model selection for Narriflow (2026-11-13)

Goal: the cheapest model that is accurate enough for each job. Every price below was read from the provider's official page on 2026-11-13; OpenAI, Anthropic and Gemini prices were also checked in the owner's Chrome. Every quality number comes from a named source or from our own test data.

Sources:
- Sol's independent report: `scratchpad/sol-model-market-2026-11.md`.
- Four research reports: `scratchpad/research/*.md`.
- Our own filler measurements: `scratchpad/filler-eval/`.

The scratchpad is `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/ddac76e8-64de-4c2d-8ab8-5806118cf578/scratchpad/`.

## What changed in the market

Three things affect us directly:

- **gpt-4o-mini-tts shuts down on 2027-01-06.** Its replacement is not a drop-in model for `/audio/speech`.
- **gpt-image-2 shuts down on 2027-02-10.** The replacements are gpt-image-2.6 Flare and Sunburst.
- **ElevenLabs Scribe v3 launched on 2026-11-10** at the same $0.20/hour as v2. The vendor claims 27% fewer word errors across 102 languages.

New cheap models at $0.10 input / $0.50 output per 1M tokens:

| Model | Note |
|---|---|
| OpenAI gpt-6-luna | Half the price of gpt-5.6-luna; strict JSON supported |
| Anthropic claude-haiku-5-5 | This price applies only to prompts up to 100K tokens; above that it is 5× |
| Meta muse-ember-1.0 | Same price band |
| Gemini 2.5 Flash-Lite | $0.10 / $0.40 |
| DeepSeek V4.1 Flash, GLM-5.3-Flash, Qwen3.8-Flash | $0.15 / ~$0.50 |

Promotional prices are ending:
- **Gemini 4 Argon and Carbon** double on Dec 1.
- **Gemini 3.8 Flash and its TTS models** double on Jan 1. After that, 3.8 Flash costs $1.50/$7.50, which is more than our current gpt-5.4-mini.

Coding benchmarks (DeepSWE, CursorBench) contradict each other for the same model. For example, gpt-5.6-luna is a top value pick on DeepSWE and near the bottom of CursorBench. Neither benchmark measures our jobs, so they are not used for any decision here.

## Recommendations by job

| Job | Today | Recommendation | Evidence | Status |
|---|---|---|---|---|
| Filler tagging (non-English) | gpt-5.6-luna + gpt-5.4 must agree, $28.05 per 1M words | **gpt-6-luna, reasoning `none`** | Measured on our data (table below): same 0 wrong tags, more fillers found, 30× cheaper | Ready to switch |
| Clip selection | gpt-5.4-mini, medium reasoning ($0.75/$4.50) | Blind A/B of gpt-6-luna medium, claude-haiku-5-5 medium and gemini-3.8-flash against the current model | No public benchmark measures viral-moment picking. Gemini 3.8 Flash leads cheap creative writing (Arena 1488). Haiku leads intelligence per dollar (Artificial Analysis 36 at $0.077 blended). Luna and Haiku are about 8× cheaper than mini. | Needs a human-rated test on our own videos |
| Titles, hooks, posts, content suite | gpt-5.4-mini | Same A/B: gpt-6-luna vs gemini-3.8-flash vs mini | Gemini 3.8 Flash has the best cheap creative score. gpt-6-luna is the cheapest (Creative Arena 1408 at max). Haiku is weaker at creative writing (1361). | Needs human preference ratings in Hindi, Urdu and English |
| Dubbing translation | gpt-5.4-mini | Test gemini-3.5-flash-lite ($0.30/$2.50) and gpt-6-luna against mini | Google says Flash-Lite is built for translation. Gemini leads the indirect Hindi/Urdu evidence (WMT26 human rank, UrduMMLU 90.2%, Artificial Analysis Hindi index). No current English↔Hindi/Urdu translation leaderboard exists. | Needs bilingual reviewers |
| Dubbing voice (TTS) | gpt-4o-mini-tts, **shuts down 2027-01-06** | Audition gemini-3.8-flash-lite-tts (≈ $0.55/hour), gemini-3.8-flash-tts (≈ $0.82/hour) and ElevenLabs v4 turbo (≈ $2.16/hour) | Voice Arena: Eleven v4 1340, Flash TTS 1284, Flash-Lite TTS 1260. Gemini TTS prices double on Jan 1. | **Urgent:** must move before Jan 6 |
| Thumbnails | gpt-image-2 medium, **shuts down 2027-02-10** | Default to gpt-image-2.6-flare medium (same API); audition gemini-nano-banana-2.1 (≈ $0.034/image) | Arena: Flare medium 1383 vs current 1382. Nano Banana 2.1 scores 1328 for less money. | Before Feb 10 |
| Library search embeddings | text-embedding-3-small ($0.02/M, ≈ $0.0003 per video hour) | **Keep.** Optionally test gemini-embedding-2 for Roman Urdu ↔ Urdu-script search | Already almost free. A switch only makes sense if search quality improves. | No action |
| Speech-to-text | Scribe v2 ($0.20/hour) | **A/B Scribe v3** (same price). xAI grok-voice-transcribe-2.0 ($0.10/hour) is a cheaper challenger. | Artificial Analysis WER: v3 1.9%, v2 2.2%, Grok 2.3% (mostly English data). Our German check: v3 kept all 9 hesitations, like v2. | Test on Hindi/Urdu clips before switching |

## Filler tagging: measured on our data

All rows use the production prompt, the same acceptance rules, and the production stretched-word and duplicate-key guards.

| Setup | Wrong tags, FLEURS (102 languages, 86,659 words) | Recall on Nyra (10 languages) | $ per 1M words |
|---|---|---|---|
| Shipped: gpt-5.6-luna low + gpt-5.4 none must agree | 0 | 81.6% | 28.05 |
| **gpt-6-luna none (run 1)** | **0** | **87.7%** | **0.92** |
| **gpt-6-luna none (run 2)** | **0** | **86.7%** | **0.92** |
| gpt-6-luna low | 0 | 82.7% | 1.12 |
| gpt-6.1-terra none | 0 | 82.1% | 9.05 |
| gpt-6-luna none + gpt-6.1-terra must agree | 0 | 80.6% | 9.97 |
| gpt-6-luna none + gpt-5.6-luna low must agree | 0 | 80.2% | 3.52 |

Further checks:
- **Extra tags reviewed by hand.** gpt-6-luna makes 57 non-English tags that the shipped pair does not make and the Nyra labels do not mark. All 57 were reviewed with context, and all are hesitation sounds: es "eh", pt "hã"/"hum", de "mmh/mm/ah", it "mmh", ru "хм/э/м", pl "hm".
- **Real project clips (en, hi, ur).** English: 123/125 tagged. Hindi and Urdu: 0 wrong tags. English uses the built-in list in production anyway.

Sol's caution: a single cheap model is the higher-risk design, and Sol's first suggestion was to keep agreement with a different provider (gpt-6-luna + claude-haiku-5-5). Our data now covers that experiment for the single model. It made 0 errors on 86,659 words in two runs and put no real word into Nyra's extra tags. The deterministic real-word guards stay in place either way. Testing Haiku as an independent second voter needs an Anthropic key.

## Privacy screen

- **Fine for our data, no training on API data:**
  - OpenAI, Anthropic, Gemini paid tier ("Used to improve our products: No"), Meta Standard.
  - Hosts: Fireworks, Groq, Together, DeepInfra.
- **Avoid first-party:**
  - DeepSeek: data stored in China, and user input is listed as training data.
  - Moonshot: trains on inputs by default.
  - Use these open models only through a no-retention host.
- **Unverified:** MiniMax's policy could not be read.

## What we need to run the remaining tests

- **API keys:** Anthropic and Google. Alternatively, one OpenRouter key covers both.
- **Human ratings:** 2–3 people to rate blinded clip picks, copy, Hindi/Urdu translation and voice samples. No public benchmark measures these for our audience.
