# Filler-tagging evaluation harness

This harness produced the numbers in [docs/ai-model-options.md](../../../docs/ai-model-options.md#filler-words). Run any script with `bun <script>` from this folder. It reads `OPENAI_API_KEY` from `apps/api/.dev.vars`, so other providers need an adapter in `run.ts`.

## Datasets

The datasets are not committed. Build them into this folder:

| Dataset | Build | What it tests |
|---|---|---|
| FLEURS (Google, CC BY 4.0) | `bun build-fleurs.ts` downloads the 102-language test sentences from Hugging Face and writes `fleurs-units.json`. | Read speech with no hesitations, so every tag is a false positive. |
| Nyra verbatim benchmark | `git clone https://github.com/nyrahealth/nyra_verbatim_speech_benchmark nyra`, then `bun build-nyra.ts`, which writes `nyra-units.json`. | 10 languages of conversational speech, with Scribe's output aligned to human `[UH]`/`[UM]` labels. The labels miss many real hesitations, so review unlabelled tags by hand. The repository has no license file: internal use only. |
| Dev clips | `clips-unique.json`, exported read-only from the dev database (en/hi/ur clip transcripts). | Real product transcripts. It contains user content, so never commit it. |

The Nyra units restart timestamps for every utterance, which makes word keys collide. Before running `prod-eval.ts`, rewrite each unit's word times so they increase across the whole unit.

## Scripts

| Script | What it does |
|---|---|
| `run.ts <model> <effort> <out.json>` | One model over a dataset (`INPUT=<units.json> VARIANT=v2`). `VARIANT=v2` is the production prompt and schema. |
| `score-fleurs.ts`, `score-nyra.ts`, `score-dev.ts` | Score one run. |
| `score-and.ts <set> <a.json> <b.json>` | Score two models that must agree. |
| `compare-setups.ts` | Every setup under the production acceptance and key guards, with cost per million words. Edit its `runs` and `setups` lists. |
| `prod-eval.ts` / `score-prod.ts` | Run the actual production module (chunking, streaming, guards) over a dataset. |
| `spend.ts` | Add up the recorded spend. |

## Bar for a new model

A new model, or a second voter, must meet all three before it ships:
- 0 wrong tags on FLEURS, in two runs;
- no real word among Nyra's unlabelled tags, after review in context;
- no Hindi/Urdu trap words on the dev clips.
