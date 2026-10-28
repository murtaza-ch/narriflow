import { describe, expect, test } from "bun:test";
import {
  detectAutoCensorSuggestions,
  maskCensorTermForDisplay,
} from "./auto-censor";
import {
  censorTermIssue,
  censorWordCategory,
  censorWordsToScan,
  readProjectCensorTerms,
  DEFAULT_CENSOR_WORD_LIST,
  DEFAULT_CENSOR_WORDS,
  effectiveWorkspaceCensorWords,
  projectCensorTermsSchema,
  WORKSPACE_CENSOR_WORDS_MAX,
  workspaceCensorWordsSchema,
} from "./censor-words";

function scan(
  text: string,
  terms: { workspace?: readonly string[]; brand?: string[]; project?: string[] } = {},
) {
  const words = text.split(" ").map((word, index) => ({
    word,
    startSec: index * 0.5,
    endSec: index * 0.5 + 0.4,
    confidence: 0.9,
  }));
  return detectAutoCensorSuggestions({
    documentRevision: 1,
    locale: "en",
    clipWindow: { startSec: 0, endSec: 60 },
    transcript: [{
      index: 0, speakerLabel: "Speaker 1", startSec: 0, endSec: 60, text, confidence: 0.9, words,
    }],
    workspaceTerms: terms.workspace ?? DEFAULT_CENSOR_WORD_LIST,
    brandTerms: terms.brand ?? [],
    projectTerms: terms.project ?? [],
    paddingSec: 0,
  });
}

const matched = (text: string, terms?: Parameters<typeof scan>[1]) =>
  scan(text, terms).map((suggestion) => suggestion.matchedText);

describe("default censored words", () => {
  test("fit the Workspace limit and every term is valid and unique", () => {
    expect(DEFAULT_CENSOR_WORD_LIST.length).toBeLessThan(WORKSPACE_CENSOR_WORDS_MAX);
    expect(workspaceCensorWordsSchema.parse(DEFAULT_CENSOR_WORD_LIST)).toEqual([
      ...DEFAULT_CENSOR_WORD_LIST,
    ]);
    for (const word of DEFAULT_CENSOR_WORD_LIST) expect(censorTermIssue(word)).toBeNull();
  });

  test("catch common profanity and variants across the six languages", () => {
    expect(matched("what a motherfucker and a bullshit shitty day, he fucked it")).toEqual([
      "motherfucker", "bullshit", "shitty", "fucked",
    ]);
    expect(matched("dickhead")).toEqual(["dickhead"]);
    expect(matched("hijo de puta, no joder, qué mierda")).toEqual([
      "hijo de puta,", "joder,", "mierda",
    ]);
    expect(matched("putain de merde")).toEqual(["putain", "merde"]);
    expect(matched("so ein Scheißkerl, Arschloch")).toEqual(["Scheißkerl,", "Arschloch"]);
    expect(matched("que merda, caralho")).toEqual(["merda,", "caralho"]);
    expect(matched("che cazzo, vaffanculo")).toEqual(["cazzo,", "vaffanculo"]);
  });

  test("flag slurs as slurs and leave other terms as profanity", () => {
    expect(scan("retarded").map((suggestion) => suggestion.policyCategory)).toEqual(["slur"]);
    expect(scan("fuck").map((suggestion) => suggestion.policyCategory)).toEqual(["profanity"]);
    expect(censorWordCategory("Retarded")).toBe("slur");
    expect(censorWordCategory("anything else")).toBe("profanity");
    expect(DEFAULT_CENSOR_WORDS.some((word) => word.category === "slur")).toBe(true);
  });

  test("never match inside an unrelated word (the Scunthorpe problem)", () => {
    expect(matched("Scunthorpe class assassin shiitake shitake fickle retardant passage cockpit")).toEqual([
      // "shitake" is a common misspelling of shiitake, so it must not be a stem match.
    ]);
    expect(matched("class assume bass", { workspace: ["ass"] })).toEqual([]);
  });

  test("ignore case, punctuation and full-width letters", () => {
    expect(matched("FUCKING, wild SHIT! ＳＨＩＴ.")).toEqual(["FUCKING,", "SHIT!", "ＳＨＩＴ."]);
  });

  test("match multi-word terms within one utterance only", () => {
    expect(matched("you son of a bitch")).toEqual(["son of a bitch"]);
    expect(matched("son of")).toEqual([]);
  });
});

describe("trailing wildcard terms", () => {
  test("match whole words that start with the stem", () => {
    expect(matched("fuck fucker fuckface unfuck", { workspace: ["fuck*"] })).toEqual([
      "fuck", "fucker", "fuckface",
    ]);
  });

  test("keep literal words exact", () => {
    expect(matched("ship shipped", { workspace: ["ship"] })).toEqual(["ship"]);
  });

  test("work in project and brand terms and inside a phrase", () => {
    expect(matched("launching launched later", { project: ["launch*"] })).toEqual([
      "launching", "launched",
    ]);
    expect(matched("big leaks leaked", { brand: ["leak*"] })).toEqual(["leaks", "leaked"]);
    expect(matched("holy crapola", { workspace: ["holy crap*"] })).toEqual(["holy crapola"]);
  });

  test("a stem shorter than three letters never matches", () => {
    expect(matched("a an and", { workspace: ["a*", "an*"] })).toEqual([]);
  });

  test("are rejected by the list schemas unless the * ends a word and the stem is long enough", () => {
    expect(censorTermIssue("fu*ck")).not.toBeNull();
    expect(censorTermIssue("fu*")).not.toBeNull();
    expect(censorTermIssue("fuck*")).toBeNull();
    expect(censorTermIssue("holy crap*")).toBeNull();
    expect(() => workspaceCensorWordsSchema.parse(["f*ck"])).toThrow();
    expect(() => projectCensorTermsSchema.parse(["a*"])).toThrow();
  });
});

describe("source priority", () => {
  test("project beats brand beats workspace on the same span", () => {
    const [onlyMatch, ...rest] = scan("shit", {
      workspace: ["shit"], brand: ["shit"], project: ["shit"],
    });
    expect(rest).toEqual([]);
    expect(onlyMatch?.policySource).toBe("project");
    expect(scan("shit", { workspace: ["shit"], brand: ["shit"] })[0]?.policySource).toBe("brand_profile");
    expect(scan("shit", { workspace: ["shit"] })[0]?.policySource).toBe("workspace");
  });

  test("a deleted default stops matching once the list is customized", () => {
    expect(matched("shit", { workspace: ["bullshit"] })).toEqual([]);
  });
});

describe("workspace list", () => {
  test("uses the defaults until customized, then exactly the stored list", () => {
    expect(effectiveWorkspaceCensorWords({ censorWords: [], censorWordsCustomized: false }))
      .toEqual({ words: [...DEFAULT_CENSOR_WORD_LIST], customized: false });
    expect(effectiveWorkspaceCensorWords({ censorWords: [], censorWordsCustomized: true }))
      .toEqual({ words: [], customized: true });
    expect(effectiveWorkspaceCensorWords({ censorWords: ["heck"], censorWordsCustomized: true }))
      .toEqual({ words: ["heck"], customized: true });
  });

  test("trims, de-duplicates case-insensitively and enforces the limits", () => {
    expect(workspaceCensorWordsSchema.parse([" Heck ", "heck", "HECK", "darn"])).toEqual(["Heck", "darn"]);
    expect(() => workspaceCensorWordsSchema.parse([""])).toThrow();
    expect(() => workspaceCensorWordsSchema.parse(["x".repeat(81)])).toThrow();
    expect(() =>
      workspaceCensorWordsSchema.parse(Array.from({ length: 201 }, (_, index) => `word${index}`)),
    ).toThrow();
    expect(workspaceCensorWordsSchema.parse(Array.from({ length: 200 }, (_, index) => `word${index}`)))
      .toHaveLength(200);
  });
});

describe("maskCensorTermForDisplay", () => {
  test("keeps the first and last letter of every word", () => {
    expect(maskCensorTermForDisplay("fuck")).toBe("f**k");
    expect(maskCensorTermForDisplay("fuck*")).toBe("f**k*");
    expect(maskCensorTermForDisplay("son of a bitch")).toBe("s*n ** * b***h");
    expect(maskCensorTermForDisplay("scheiß")).toBe("s****ß");
  });
});

const defaults = { words: [...DEFAULT_CENSOR_WORD_LIST], customized: false };
const scanFor = (locale: string, text: string) =>
  matched(text, { workspace: censorWordsToScan(defaults, locale) });

describe("default words by language", () => {
  test("an unedited list scans English plus the clip's own language", () => {
    expect(scanFor("fr-FR", "putain what the fuck")).toEqual(["putain", "fuck"]);
    // Other languages' words are not checked against a French clip.
    expect(scanFor("fr", "cazzo scheisse caralho mierda")).toEqual([]);
    expect(scanFor("de_DE", "scheisse und fuck")).toEqual(["scheisse", "fuck"]);
    expect(scanFor("pt-BR", "que merda, caralho")).toEqual(["merda,", "caralho"]);
    expect(scanFor("it", "che merda, cazzo")).toEqual(["merda,", "cazzo"]);
    expect(scanFor("es", "joder, que mierda")).toEqual(["joder,", "mierda"]);
    expect(scanFor("xx", "fuck")).toEqual(["fuck"]);
  });

  test("an edited list applies as stored, in every language", () => {
    const edited = { words: ["cazzo*", "fuck*"], customized: true };
    expect(censorWordsToScan(edited, "fr")).toEqual(["cazzo*", "fuck*"]);
  });

  test("no English entry is an everyday word in another language", () => {
    expect(scanFor("fr", "Je suis en retard pour le dîner, des retards partout")).toEqual([]);
    expect(matched("Je suis en retard")).toEqual([]);
    expect(matched("that was retarded")).toEqual(["retarded"]);
  });

  test("common innocent words and names never match, in any language, even with every default active", () => {
    const innocent = [
      "Moby Dick, a class assassin, the shiitake and shitake dish, a fickle passage, retardant foam, a cockpit, Scunthorpe, bass, Essex",
      "Kike Hernandez comes from Verga, porra means churros, la disputa de la computadora, el pitufo, un problema, pelotudo",
      "Je suis en retard pour le dîner, la mer est belle, un bordel de livres, un bâtard de pain, connaître la salade, Pétain",
      "Das Wetter ist schön in der Schweiz, die Scheibe, Fick und Ficker sind Nachnamen, Huren heißt mieten auf Niederländisch, Arbeit",
      "Eu estou atrasado, o cacete é pão, a coisa, computação, vaca",
      "Il signor Verga, la cazzuola del muratore, il culatello, Cazzaniga, minestra",
    ].join(" ").replace(/,/g, "");
    const all = { words: [...DEFAULT_CENSOR_WORD_LIST], customized: true };
    expect(matched(innocent, { workspace: censorWordsToScan(all, "en") })).toEqual([]);
  });
});

describe("contractions", () => {
  test("a contraction still matches the censored word", () => {
    expect(matched("that shit's wild and he fuck'd up, the bitch’s car")).toEqual([
      "shit's", "fuck'd", "bitch’s",
    ]);
    expect(matched("shit's", { workspace: ["shit"] })).toEqual(["shit's"]);
  });

  test("do not turn other words into matches", () => {
    expect(matched("shits shitty it's she'd", { workspace: ["shit"] })).toEqual([]);
    expect(matched("don't can't", { workspace: ["don", "can"] })).toEqual([]);
  });
});

describe("readProjectCensorTerms", () => {
  test("keeps valid terms and drops the rest instead of throwing", () => {
    expect(readProjectCensorTerms(["fu*ck", "ab*", "launch*", "Launch*", 42, null, "x".repeat(81), " ok word "]))
      .toEqual(["launch*", "ok word"]);
    expect(readProjectCensorTerms(undefined)).toEqual([]);
    expect(readProjectCensorTerms({ not: "a list" })).toEqual([]);
    expect(readProjectCensorTerms(Array.from({ length: 80 }, (_, index) => `word${index}`))).toHaveLength(50);
  });
});
