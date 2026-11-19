/**
 * Gate G1 for caption emphasis (spec `.scratch/dynamic-captions/spec.md`):
 * blind pick sheets from real transcripts, then agreement of the scorer and
 * the baseline with the labels.
 *
 *   bun packages/validators/scripts/emphasis-sheet.ts export --db-env <file> --out <export.json> [--en-clips 40]
 *   bun packages/validators/scripts/emphasis-sheet.ts sheet <export.json> <outDir> [--en-cues 6] [--south-asian-cues 4]
 *   bun packages/validators/scripts/emphasis-sheet.ts score <export.json> <labels.json> <sheet.json>... [--weights <json>] [--details]
 *
 * `export` reads the dev database through psql in a read-only transaction.
 * Real transcripts must stay out of git: every output path inside this
 * repository is refused. Labels are `{ "<cue id>": { "acceptable": string[] | "none" } }`;
 * an `acceptable` list may also contain "none" when no hero is equally fine.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { autoCensorWordId } from "../src/auto-censor";
import { groupCaptionTokens } from "../src/caption-cues";
import {
  assignCaptionRoles,
  baselineCaptionHero,
  CAPTION_EMPHASIS_WEIGHTS,
  captionWordKey,
  type CaptionEmphasisWeights,
  type CaptionEmphasisWord,
} from "../src/caption-emphasis";
import { formatCaptionWord } from "../src/caption-preset";
import { buildClipCutPlan, sourceRangeToEdited, sourceWordToEdited, type SourceRange } from "../src/edit-ranges";
import { joinTranscriptWords } from "../src/text-script";
import type { TranscriptUtterance } from "../src/transcript";

const WORDS_PER_CUE = 4;
const REPOSITORY_ROOT = resolve(import.meta.dir, "../../..");

interface ExportClip {
  readonly id: string;
  readonly projectId: string;
  readonly language: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly deletedRanges: SourceRange[] | null;
  readonly censorSegments: readonly {
    readonly enabled?: boolean;
    readonly treatment: string;
    readonly captionMaskPolicy: unknown;
    readonly sourceWordIds: readonly string[];
  }[];
  readonly transcriptSlice: readonly TranscriptUtterance[];
}

interface ExportFile {
  readonly exportedAt: string;
  readonly clips: readonly ExportClip[];
}

type LanguageGroup = "english" | "native" | "roman";

interface SheetWord {
  readonly text: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly pauseBeforeSec: number;
}

interface SheetCue {
  readonly id: string;
  readonly clipId: string;
  readonly cueIndex: number;
  readonly language: string;
  readonly group: LanguageGroup;
  readonly words: readonly SheetWord[];
  readonly before: string | null;
  readonly after: string | null;
}

interface SheetFile {
  readonly sheet: "tuning" | "heldout";
  readonly wordsPerCue: number;
  readonly cues: readonly SheetCue[];
}

interface ClipCue {
  readonly words: readonly CaptionEmphasisWord[];
  readonly display: readonly SheetWord[];
  readonly untimed: boolean;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) fail(`${name} needs a value`);
  args.splice(index, 2);
  return value;
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index !== -1) args.splice(index, 1);
  return index !== -1;
}

/** Real transcripts never go into the repository. */
function outsideRepository(path: string): string {
  const absolute = resolve(path);
  if (absolute === REPOSITORY_ROOT || absolute.startsWith(REPOSITORY_ROOT + sep)) {
    fail(`refusing to write inside the repository: ${absolute}`);
  }
  return absolute;
}

function writeOutput(path: string, content: string) {
  const absolute = outsideRepository(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  console.log(`wrote ${absolute}`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// ---------------------------------------------------------------- export

function databaseUrl(envFile: string | undefined): string {
  if (envFile) {
    const line = readFileSync(envFile, "utf8").split("\n").find((entry) => entry.startsWith("DATABASE_URL="));
    if (!line) fail(`no DATABASE_URL in ${envFile}`);
    return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  return process.env.DATABASE_URL ?? fail("pass --db-env <file> or set DATABASE_URL");
}

/** psql settings from a connection URL, kept out of argv so the password is not in the process list. */
function psqlEnvironment(url: string): Record<string, string> {
  const parsed = new URL(url);
  const sslmode = parsed.searchParams.get("sslmode");
  const channelBinding = parsed.searchParams.get("channel_binding");
  return {
    ...(process.env as Record<string, string>),
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: parsed.pathname.replace(/^\//, ""),
    ...(sslmode ? { PGSSLMODE: sslmode } : {}),
    ...(sslmode === "verify-full" || sslmode === "verify-ca" ? { PGSSLROOTCERT: "system" } : {}),
    ...(channelBinding ? { PGCHANNELBINDING: channelBinding } : {}),
    PGOPTIONS: "-c default_transaction_read_only=on",
  };
}

const EXPORT_SQL = `
select coalesce(json_agg(row_to_json(clip)), '[]'::json) from (
  select c.id, c."projectId", t."languageCode" as language, c."startSec", c."endSec",
         c."deletedRanges", c."censorSegments", c."transcriptSlice"
  from "Clip" c join "Transcript" t on t."projectId" = c."projectId"
  where t."languageCode" in ('en', 'ur', 'hi') and jsonb_typeof(c."transcriptSlice") = 'array'
  order by c."projectId", c."startSec", c.id
) clip`;

function timedWordCount(clip: ExportClip): number {
  return clip.transcriptSlice.reduce((total, utterance) => total + utterance.words.length, 0);
}

function wordShingles(clip: ExportClip): Set<string> {
  const words = clip.transcriptSlice.flatMap((utterance) => utterance.words.map((word) => word.word.toLowerCase()));
  return new Set(words.slice(0, Math.max(0, words.length - 4)).map((_, index) => words.slice(index, index + 5).join(" ")));
}

/**
 * One clip per stretch of speech: re-runs of clip selection, and the same
 * video imported into two projects, repeat the same words.
 */
function withoutOverlaps(clips: readonly ExportClip[]): ExportClip[] {
  const kept: ExportClip[] = [];
  const seen = new Set<string>();
  for (const clip of clips) {
    const shingles = wordShingles(clip);
    const repeated = [...shingles].filter((shingle) => seen.has(shingle)).length;
    if (shingles.size === 0 || repeated / shingles.size > 0.2) continue;
    kept.push(clip);
    for (const shingle of shingles) seen.add(shingle);
  }
  return kept;
}

/** Up to `limit` clips, taken round-robin across projects so no speaker dominates. */
function roundRobin(clips: readonly ExportClip[], limit: number): ExportClip[] {
  const byProject = new Map<string, ExportClip[]>();
  for (const clip of clips) byProject.set(clip.projectId, [...(byProject.get(clip.projectId) ?? []), clip]);
  const queues = [...byProject.values()];
  const picked: ExportClip[] = [];
  while (picked.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next && picked.length < limit) picked.push(next);
    }
  }
  return picked;
}

function runExport(args: string[]) {
  const out = option(args, "--out") ?? fail("export needs --out <export.json>");
  const englishClips = Number(option(args, "--en-clips") ?? 40);
  outsideRepository(out);
  const result = Bun.spawnSync(["psql", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-At", "-c", EXPORT_SQL], {
    env: psqlEnvironment(databaseUrl(option(args, "--db-env"))),
  });
  if (result.exitCode !== 0) fail(`psql failed: ${result.stderr.toString()}`);
  const rows = JSON.parse(result.stdout.toString()) as ExportClip[];
  const usable = withoutOverlaps(rows.filter((clip) => timedWordCount(clip) > 0));
  const english = roundRobin(usable.filter((clip) => clip.language === "en"), englishClips);
  const southAsian = usable.filter((clip) => clip.language === "ur" || clip.language === "hi");
  const clips = [...english, ...southAsian].map((clip) => ({
    ...clip,
    deletedRanges: clip.deletedRanges ?? [],
    censorSegments: clip.censorSegments ?? [],
  }));
  const file: ExportFile = { exportedAt: new Date().toISOString(), clips };
  writeOutput(out, JSON.stringify(file));
  const count = (language: string) => clips.filter((clip) => clip.language === language).length;
  console.log(`clips: en ${count("en")}, ur ${count("ur")}, hi ${count("hi")} (of ${rows.length} rows)`);
}

// ---------------------------------------------------------------- cues

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The clip's cues as the composition plan groups them today, with the scorer's word input. */
function clipCues(clip: ExportClip): ClipCue[] {
  const map = buildClipCutPlan(clip.deletedRanges ?? [], { startSec: clip.startSec, endSec: clip.endSec }).map;
  const cues: ClipCue[] = [];
  let previousEnd: number | null = null;
  for (const utterance of clip.transcriptSlice) {
    if (utterance.words.length === 0) {
      const range = sourceRangeToEdited(map, utterance);
      if (!range || !utterance.text.trim()) continue;
      const pause = previousEnd === null ? 0 : Math.max(0, range.startSec - previousEnd);
      previousEnd = range.endSec;
      cues.push({
        untimed: true,
        words: [{
          key: captionWordKey(utterance.startSec),
          raw: utterance.text,
          sourceStartSec: utterance.startSec,
          sourceEndSec: utterance.endSec,
          utteranceIndex: utterance.index,
          utteranceFinal: true,
          pauseBeforeSec: pause,
          masked: false,
          untimed: true,
        }],
        display: [{ text: utterance.text, startSec: round(range.startSec), endSec: round(range.endSec), pauseBeforeSec: round(pause) }],
      });
      continue;
    }
    const visible = utterance.words.flatMap((word, wordIndex) => {
      const range = sourceWordToEdited(map, word);
      const formatted = formatCaptionWord(word.word, { punctuation: true }).trim();
      if (!range || !formatted) return [];
      const wordId = autoCensorWordId({ utteranceIndex: utterance.index, wordIndex, word });
      const masked = (clip.censorSegments ?? []).some((segment) =>
        segment.enabled !== false &&
        segment.treatment === "caption_mask" &&
        segment.captionMaskPolicy !== null &&
        segment.sourceWordIds.includes(wordId),
      );
      return [{ word, range, formatted, masked }];
    });
    const timed = visible.map((entry, index): { emphasis: CaptionEmphasisWord; display: SheetWord } => {
      const pause = previousEnd === null ? 0 : Math.max(0, entry.range.startSec - previousEnd);
      previousEnd = entry.range.endSec;
      return {
        emphasis: {
          key: captionWordKey(entry.word.startSec),
          raw: entry.word.word,
          sourceStartSec: entry.word.startSec,
          sourceEndSec: entry.word.endSec,
          utteranceIndex: utterance.index,
          utteranceFinal: index === visible.length - 1,
          pauseBeforeSec: pause,
          masked: entry.masked,
        },
        display: {
          text: entry.formatted,
          startSec: round(entry.range.startSec),
          endSec: round(entry.range.endSec),
          pauseBeforeSec: round(pause),
        },
      };
    });
    for (const group of groupCaptionTokens(visible.map((entry) => entry.formatted), WORDS_PER_CUE)) {
      const slice = timed.slice(group.start, group.end);
      cues.push({ untimed: false, words: slice.map((entry) => entry.emphasis), display: slice.map((entry) => entry.display) });
    }
  }
  return cues;
}

function cueText(cue: ClipCue | undefined): string | null {
  return cue ? joinTranscriptWords(cue.display.map((word) => ({ word: word.text }))) : null;
}

const NATIVE_RE = /[\p{Script=Arabic}\p{Script=Devanagari}]/u;
const LATIN_RE = /\p{Script=Latin}/u;

function languageGroup(language: string, cue: ClipCue): LanguageGroup {
  if (language === "en") return "english";
  let native = 0;
  let latin = 0;
  for (const char of cue.words.map((word) => word.raw).join("")) {
    if (NATIVE_RE.test(char)) native += 1;
    else if (LATIN_RE.test(char)) latin += 1;
  }
  return native >= latin ? "native" : "roman";
}

// ---------------------------------------------------------------- sheet

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cueId(clip: ExportClip, cueIndex: number): string {
  return `${clip.id.slice(0, 8)}-${cueIndex}`;
}

function sheetMarkdown(sheet: SheetFile): string {
  const lines = [
    `# G1 ${sheet.sheet === "tuning" ? "tuning" : "held-out"} sheet (blind)`,
    "",
    `${sheet.cues.length} cues, grouped as captions group them today (${sheet.wordsPerCue} words per cue).`,
    "For each cue, list 1 to 3 words that would be an acceptable hero (the one emphasised word, or",
    "a number with its unit), copied from the cue, or \"none\" when no word deserves emphasis.",
    "Times are seconds on the clip's edited timeline; \"pause\" is the silence before the word.",
    "",
    "Labels file: `{ \"<cue id>\": { \"acceptable\": [\"word\", ...] } }` or `{ \"acceptable\": \"none\" }`.",
    "",
  ];
  for (const cue of sheet.cues) {
    lines.push(`## ${cue.id} · ${cue.language} · ${cue.group}`, "");
    lines.push(`Before: ${cue.before ?? "(start of clip)"}`, "");
    lines.push("| # | word | start | end | pause |", "| --- | --- | --- | --- | --- |");
    cue.words.forEach((word, index) => {
      lines.push(`| ${index + 1} | ${word.text.replaceAll("|", "\\|")} | ${word.startSec.toFixed(2)} | ${word.endSec.toFixed(2)} | ${word.pauseBeforeSec.toFixed(2)} |`);
    });
    lines.push("", `After: ${cue.after ?? "(end of clip)"}`, "");
  }
  return lines.join("\n");
}

function runSheet(args: string[]) {
  const englishCues = Number(option(args, "--en-cues") ?? 6);
  const southAsianCues = Number(option(args, "--south-asian-cues") ?? 4);
  const [exportPath, outDir] = args;
  if (!exportPath || !outDir) fail("sheet needs <export.json> <outDir>");
  const file = readJson<ExportFile>(exportPath);
  const sheets: Record<SheetFile["sheet"], SheetCue[]> = { tuning: [], heldout: [] };
  for (const languages of [["en"], ["ur", "hi"]]) {
    const clips = file.clips
      .filter((clip) => languages.includes(clip.language))
      .sort((left, right) => compare(left.language, right.language) || compare(left.projectId, right.projectId) || left.startSec - right.startSec);
    const perClip = languages.includes("en") ? englishCues : southAsianCues;
    clips.forEach((clip, clipIndex) => {
      const cues = clipCues(clip);
      const timed = cues.flatMap((cue, cueIndex) => (cue.untimed ? [] : [cueIndex]));
      const from = Math.max(0, Math.floor((timed.length - perClip) / 2));
      for (const cueIndex of timed.slice(from, from + perClip)) {
        const cue = cues[cueIndex]!;
        sheets[clipIndex % 2 === 0 ? "tuning" : "heldout"].push({
          id: cueId(clip, cueIndex),
          clipId: clip.id,
          cueIndex,
          language: clip.language,
          group: languageGroup(clip.language, cue),
          words: cue.display,
          before: cueText(cues[cueIndex - 1]),
          after: cueText(cues[cueIndex + 1]),
        });
      }
    });
  }
  for (const name of ["tuning", "heldout"] as const) {
    const sheet: SheetFile = { sheet: name, wordsPerCue: WORDS_PER_CUE, cues: sheets[name] };
    writeOutput(join(outDir, `${name}.json`), JSON.stringify(sheet, null, 2));
    writeOutput(join(outDir, `${name}.md`), sheetMarkdown(sheet));
    const count = (group: LanguageGroup) => sheet.cues.filter((cue) => cue.group === group).length;
    console.log(`${name}: ${sheet.cues.length} cues (english ${count("english")}, native ${count("native")}, roman ${count("roman")})`);
  }
}

// ---------------------------------------------------------------- score

interface Label {
  readonly acceptable: readonly string[] | "none";
}

function labelWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}']/gu, "");
}

/** A pick agrees when any of its words is an acceptable word; no pick agrees only when "none" is acceptable. */
function agrees(pick: readonly string[] | null, label: Label): boolean {
  const entries = label.acceptable === "none" ? ["none"] : label.acceptable;
  if (pick === null) return entries.some((entry) => entry.trim().toLowerCase() === "none");
  const acceptable = new Set(
    entries.filter((entry) => entry.trim().toLowerCase() !== "none").flatMap((entry) => entry.split(/\s+/).map(labelWord)),
  );
  return pick.some((word) => acceptable.has(labelWord(word)));
}

function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;
}

function runScore(args: string[]) {
  const weightsPath = option(args, "--weights");
  const details = flag(args, "--details");
  const [exportPath, labelsPath, ...sheetPaths] = args;
  if (!exportPath || !labelsPath || sheetPaths.length === 0) fail("score needs <export.json> <labels.json> <sheet.json>...");
  const weights: CaptionEmphasisWeights = {
    ...CAPTION_EMPHASIS_WEIGHTS,
    ...(weightsPath ? readJson<Partial<CaptionEmphasisWeights>>(weightsPath) : {}),
  };
  const labels = readJson<Record<string, Label>>(labelsPath);
  const picks = new Map<string, { scorer: string[] | null; baseline: string[] | null; text: string }>();
  for (const clip of readJson<ExportFile>(exportPath).clips) {
    const cues = clipCues(clip);
    const input = { cues: cues.map((cue) => cue.words), language: clip.language };
    const scorer = assignCaptionRoles({ ...input, overrides: {}, policy: "auto", weights });
    const baseline = baselineCaptionHero(input);
    const words = (cueIndex: number, span: readonly [number, number] | null) =>
      span === null ? null : cues[cueIndex]!.display.slice(span[0], span[1] + 1).map((word) => word.text);
    cues.forEach((cue, cueIndex) => {
      picks.set(cueId(clip, cueIndex), {
        scorer: words(cueIndex, scorer[cueIndex]!.heroSpan),
        baseline: words(cueIndex, baseline[cueIndex]!),
        text: cueText(cue) ?? "",
      });
    });
  }
  console.log(`weights: ${JSON.stringify(weights)}`);
  for (const sheetPath of sheetPaths) {
    const sheet = readJson<SheetFile>(sheetPath);
    console.log(`\n${sheet.sheet}: ${sheet.cues.length} cues`);
    console.log("group     labelled  scorer  baseline  margin  no-hero  pass (>=80% and +10)");
    let unlabelled = 0;
    for (const group of ["english", "native", "roman"] as const) {
      let total = 0;
      let scorerAgree = 0;
      let baselineAgree = 0;
      let scorerNone = 0;
      for (const cue of sheet.cues.filter((entry) => entry.group === group)) {
        const label = labels[cue.id];
        const pick = picks.get(cue.id);
        if (!label || !pick) {
          unlabelled += 1;
          continue;
        }
        total += 1;
        const scorerOk = agrees(pick.scorer, label);
        if (scorerOk) scorerAgree += 1;
        if (agrees(pick.baseline, label)) baselineAgree += 1;
        if (pick.scorer === null) scorerNone += 1;
        if (details && !scorerOk) {
          const acceptable = label.acceptable === "none" ? "none" : label.acceptable.join(" / ");
          console.log(`  miss ${cue.id} [${group}] "${pick.text}" scorer=${pick.scorer?.join(" ") ?? "none"} baseline=${pick.baseline?.join(" ") ?? "none"} acceptable=${acceptable}`);
        }
      }
      if (total === 0) {
        console.log(`${group.padEnd(9)} 0`);
        continue;
      }
      const scorer = percent(scorerAgree, total);
      const baseline = percent(baselineAgree, total);
      const margin = Math.round((scorer - baseline) * 10) / 10;
      const pass = scorer >= 80 && margin >= 10 ? "pass" : scorer >= 80 ? "agrees, not better than baseline" : "fail";
      console.log(
        `${group.padEnd(9)} ${String(total).padStart(8)}  ${`${scorer}%`.padStart(6)}  ${`${baseline}%`.padStart(8)}  ${String(margin).padStart(6)}  ${`${percent(scorerNone, total)}%`.padStart(7)}  ${pass}`,
      );
    }
    if (unlabelled > 0) console.log(`unlabelled: ${unlabelled}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "export") runExport(rest);
else if (command === "sheet") runSheet(rest);
else if (command === "score") runScore(rest);
else fail("usage: emphasis-sheet.ts export|sheet|score (see the header comment)");
