import { z } from "zod";

/**
 * The censored-word list. One list per Workspace, shared by every project:
 * until a Workspace edits it, it equals DEFAULT_CENSOR_WORDS; once edited, the
 * stored list replaces the defaults entirely (so defaults can be deleted too).
 *
 * A term is one or more words. A word ending in `*` is a stem and matches whole
 * transcript words that start with it (`fuck*` -> fucked, fucker). Without a
 * trailing `*` a word only matches itself, so "ass" never fires inside "class".
 */

export const WORKSPACE_CENSOR_WORDS_MAX = 200;
export const PROJECT_CENSOR_TERMS_MAX = 50;
export const CENSOR_TERM_MAX_LENGTH = 80;
export const CENSOR_STEM_MIN_LENGTH = 3;

export type CensorWordCategory = "profanity" | "slur";

export interface DefaultCensorWord {
  readonly value: string;
  readonly category: CensorWordCategory;
  /** The transcript languages it is a censored word in. English applies to every clip. */
  readonly languages: readonly string[];
}

function words(
  category: CensorWordCategory,
  languages: readonly string[],
  ...values: string[]
): DefaultCensorWord[] {
  return values.map((value) => ({ value, category, languages }));
}

/**
 * Curated across English, Spanish, French, German, Portuguese and Italian, and
 * tagged by language: while a Workspace has not edited its list, a clip is
 * scanned with the English entries plus its own transcript language's. Stems
 * stay to families with no common innocent word (`shit*` would catch "shitake"
 * and `fick*` "fickle", so those are listed word by word), and anything that is
 * also an everyday word or a common name is left out ("fag", "kike", "verga",
 * "porra", "cacete", "bordel"). English applies to every clip and an edited
 * list applies in every language, so an English entry must not be a common
 * word elsewhere either: "retard" stays out because it is French for "late". Slurs are flagged so the review can treat them
 * as slurs; they are still ordinary, deletable list entries.
 */
export const DEFAULT_CENSOR_WORDS: readonly DefaultCensorWord[] = [
  ...words("profanity", ["en"],
    "fuck*", "motherfuck*", "shit", "shits", "shitty", "shitting", "shithead*",
    "shitshow*", "shitface*", "shitstorm*", "bullshit*", "horseshit", "dipshit*",
    "bitch*", "son of a bitch", "asshole*", "arsehole*", "dickhead*", "dumbass*",
    "jackass*", "bastard*", "cunt*", "cocksucker*", "douchebag*", "wanker*",
    "twat*", "bollocks", "piss", "pissed", "pissing", "goddamn*", "whore*",
    "slut", "sluts", "slutty",
  ),
  ...words("slur", ["en"],
    "nigger*", "nigga*", "faggot*", "retarded",
  ),
  ...words("profanity", ["es"],
    "mierda*", "hijo de puta", "hijos de puta", "joder*", "coño", "cabrón", "cabron",
    "cabrones", "pendejo*", "pendeja*", "gilipollas", "chingar", "chingado",
    "chingada", "chingados", "chingadas", "carajo", "culero*",
  ),
  ...words("profanity", ["es", "pt"], "puta", "putas"),
  ...words("profanity", ["es"], "puto", "putos"),
  ...words("profanity", ["es", "it"], "culo", "culos"),
  ...words("slur", ["es"], "maricón", "maricon"),
  ...words("profanity", ["fr"],
    "merde*", "putain*", "pute", "putes", "connard*", "connasse*", "encul*",
    "salope*", "salaud*", "couille*",
  ),
  ...words("slur", ["fr"], "pédé", "pédés"),
  ...words("profanity", ["de"],
    "scheiß*", "scheiss*", "arsch", "arschloch*", "ficken", "fick dich", "fotze*",
    "wichser*", "hurensohn*", "hure",
  ),
  ...words("slur", ["de"], "neger", "schwuchtel*"),
  ...words("profanity", ["pt", "it"], "merda*"),
  ...words("profanity", ["pt"],
    "caralho*", "filho da puta", "filhos da puta", "buceta", "babaca*", "bosta",
    "cuzão", "cuzao", "arrombado*",
  ),
  ...words("slur", ["pt"], "viado*"),
  ...words("profanity", ["it"],
    "cazzo*", "stronzo*", "stronza*", "vaffanculo", "coglione*", "puttana*", "minchia",
  ),
  ...words("slur", ["it"], "frocio*"),
];

function foldTerm(term: string): string {
  return term.normalize("NFKC").toLocaleLowerCase("und").trim().replace(/\s+/g, " ");
}

const defaultByTerm = new Map(
  DEFAULT_CENSOR_WORDS.map((word) => [foldTerm(word.value), word]),
);

/** A default term's category; terms a person added themselves are plain profanity. */
export function censorWordCategory(term: string): CensorWordCategory {
  return defaultByTerm.get(foldTerm(term))?.category ?? "profanity";
}

export const DEFAULT_CENSOR_WORD_LIST: readonly string[] = DEFAULT_CENSOR_WORDS.map(
  (word) => word.value,
);

/** A word ending in `*`: its stem, or null when the word is literal. */
export function censorWildcardStem(token: string): string | null {
  return token.endsWith("*") ? token.slice(0, -1) : null;
}

export function censorTermIssue(term: string): string | null {
  const tokens = term.trim().split(/\s+/);
  for (const token of tokens) {
    const stem = censorWildcardStem(token);
    const body = stem ?? token;
    if (body.includes("*")) return "Use * only at the end of a word.";
    if (stem !== null && [...stem].length < CENSOR_STEM_MIN_LENGTH) {
      return `Keep at least ${CENSOR_STEM_MIN_LENGTH} letters before the *.`;
    }
  }
  return null;
}

export const censorTermSchema = z
  .string()
  .trim()
  .min(1)
  .max(CENSOR_TERM_MAX_LENGTH)
  .superRefine((term, context) => {
    const issue = censorTermIssue(term);
    if (issue) context.addIssue({ code: "custom", message: issue });
  });

/** Case- and width-insensitive de-duplication that keeps the first spelling. */
function uniqueTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  return terms.flatMap((term) => {
    const key = foldTerm(term);
    if (seen.has(key)) return [];
    seen.add(key);
    return [term.trim()];
  });
}

export const projectCensorTermsSchema = z
  .array(censorTermSchema)
  .max(PROJECT_CENSOR_TERMS_MAX)
  .transform(uniqueTerms);

export const workspaceCensorWordsSchema = z
  .array(censorTermSchema)
  .max(WORKSPACE_CENSOR_WORDS_MAX)
  .transform(uniqueTerms);

/** The Workspace's list as people see and edit it, and whether they have edited it. */
export interface WorkspaceCensorWords {
  readonly words: string[];
  readonly customized: boolean;
}

/** What a Workspace row holds, resolved to the list shown for editing. */
export function effectiveWorkspaceCensorWords(workspace: {
  readonly censorWords: readonly string[];
  readonly censorWordsCustomized: boolean;
}): WorkspaceCensorWords {
  return workspace.censorWordsCustomized
    ? { words: [...workspace.censorWords], customized: true }
    : { words: [...DEFAULT_CENSOR_WORD_LIST], customized: false };
}

function primaryLanguage(locale: string): string {
  return locale.trim().toLowerCase().split(/[-_]/)[0] || "en";
}

/**
 * The words a clip is scanned with. An edited list applies as stored, in every
 * language, because those are the words the Workspace chose to keep. Until it
 * is edited, only the English defaults and the clip's own language apply, so a
 * French clip is not checked against German or Italian words.
 */
export function censorWordsToScan(list: WorkspaceCensorWords, locale: string): string[] {
  if (list.customized) return list.words;
  const language = primaryLanguage(locale);
  return list.words.filter((word) => {
    const entry = defaultByTerm.get(foldTerm(word));
    if (!entry) return true;
    return entry.languages.includes(language) || entry.languages.includes("en");
  });
}

/**
 * Stored project terms, read leniently: a term the current rules reject (an
 * older form, a stray `*`) is skipped rather than failing the whole clip.
 * Writes stay strict (projectCensorTermsSchema).
 */
export function readProjectCensorTerms(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  const valid = stored.filter(
    (term): term is string => typeof term === "string" && censorTermSchema.safeParse(term).success,
  );
  return uniqueTerms(valid).slice(0, PROJECT_CENSOR_TERMS_MAX);
}
