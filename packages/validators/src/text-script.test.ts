import { describe, expect, test } from "bun:test";
import {
  isNoSpaceScriptChar,
  joinTranscriptWords,
  stripCaptionEdgePunctuation,
  textDirection,
  toCaptionLowerCase,
  toCaptionUpperCase,
} from "./text-script";

const w = (word: string, spaceBefore?: boolean) =>
  spaceBefore === undefined ? { word } : { word, spaceBefore };

describe("joinTranscriptWords", () => {
  test("English joins with single spaces and skips blank tokens", () => {
    expect(joinTranscriptWords([w("Hello"), w(" "), w(" world, "), w("again.")])).toBe(
      "Hello world, again.",
    );
    expect(joinTranscriptWords([])).toBe("");
  });

  test("Chinese per-character tokens join without spaces", () => {
    const tokens = [..."今天天气很好。"].map((c) => w(c));
    expect(joinTranscriptWords(tokens)).toBe("今天天气很好。");
  });

  test("digits abut Han and kana", () => {
    expect(joinTranscriptWords([w("2026"), w("年")])).toBe("2026年");
    expect(joinTranscriptWords([w("第"), w("3"), w("回")])).toBe("第3回");
    expect(joinTranscriptWords([w("12"), w("days")])).toBe("12 days");
  });

  test("CJK brackets attach to their neighbours", () => {
    expect(joinTranscriptWords([w("「"), w("OpenAI"), w("」")])).toBe("「OpenAI」");
    expect(joinTranscriptWords([w("是"), w("「"), w("好"), w("」"), w("的")])).toBe(
      "是「好」的",
    );
    expect(joinTranscriptWords([w("OpenAI"), w("。")])).toBe("OpenAI。");
  });

  test("Thai honours explicit phrase spaces", () => {
    const tokens = [
      w("สวัสดี"),
      w("ครับ", false),
      w("วันนี้", true),
      w("อากาศ", false),
      w("ดี", false),
    ];
    expect(joinTranscriptWords(tokens)).toBe("สวัสดีครับ วันนี้อากาศดี");
  });

  test("Thai without spaceBefore falls back to the no-space script rule", () => {
    expect(joinTranscriptWords([w("สวัสดี"), w("ครับ")])).toBe("สวัสดีครับ");
  });

  test("mixed Urdu and English keeps spaces", () => {
    expect(joinTranscriptWords([w("یہ"), w("Google"), w("کا"), w("پروڈکٹ"), w("ہے۔")])).toBe(
      "یہ Google کا پروڈکٹ ہے۔",
    );
  });

  test("Japanese with a Latin insertion follows spaceBefore, else spaces the Latin word", () => {
    const explicit = [
      w("私"),
      w("は", false),
      w("Google", false),
      w("を", false),
      w("使"),
      w("う", false),
    ];
    expect(joinTranscriptWords(explicit)).toBe("私はGoogleを使う");
    const inferred = explicit.map(({ word }) => w(word));
    expect(joinTranscriptWords(inferred)).toBe("私は Google を使う");
  });

  test("explicit spaceBefore=true overrides the script rule", () => {
    expect(joinTranscriptWords([w("今"), w("天", true)])).toBe("今 天");
  });
});

describe("isNoSpaceScriptChar", () => {
  test("identifies Han, kana, Thai, Lao, Khmer and Myanmar only", () => {
    for (const c of ["今", "あ", "ア", "ー", "ก", "ກ", "ក", "က"]) {
      expect(isNoSpaceScriptChar(c)).toBe(true);
    }
    for (const c of ["a", "1", "ا", "한", "।", "。"]) {
      expect(isNoSpaceScriptChar(c)).toBe(false);
    }
  });
});

describe("textDirection", () => {
  test("uses the first strong character", () => {
    expect(textDirection("Hello")).toBe("ltr");
    expect(textDirection("مرحبا")).toBe("rtl");
    expect(textDirection("שלום")).toBe("rtl");
    expect(textDirection("  123 «» مرحبا Hello")).toBe("rtl");
    expect(textDirection("Hello مرحبا")).toBe("ltr");
    expect(textDirection("١٢٣")).toBe("ltr");
    expect(textDirection("", "rtl")).toBe("rtl");
    expect(textDirection("今天")).toBe("ltr");
  });
});

describe("toCaptionUpperCase", () => {
  test("applies locale rules", () => {
    expect(toCaptionUpperCase("hello")).toBe("HELLO");
    expect(toCaptionUpperCase("istanbul", "tr")).toBe("İSTANBUL");
    expect(toCaptionUpperCase("привет", "ru")).toBe("ПРИВЕТ");
  });

  test("caseless scripts are untouched", () => {
    for (const text of ["今天天气", "مرحبا", "नमस्ते", "สวัสดี"]) {
      expect(toCaptionUpperCase(text, "ur")).toBe(text);
    }
  });

  test("never produces Georgian Mtavruli", () => {
    expect(toCaptionUpperCase("გამარჯობა hello", "ka")).toBe("გამარჯობა HELLO");
  });

  test("an unusable locale falls back to plain upper-casing", () => {
    expect(toCaptionUpperCase("abc", "not a locale")).toBe("ABC");
  });

  test("Turkish and Azerbaijani write a dotted capital İ and a dotless capital I", () => {
    for (const language of ["tr", "az", "tr-TR", "AZ"]) {
      expect(toCaptionUpperCase("istanbul ılık iyi", language)).toBe("İSTANBUL ILIK İYİ");
    }
    expect(toCaptionUpperCase("istanbul ılık", "en")).toBe("ISTANBUL ILIK");
  });

  test("Lithuanian drops the soft dot from capital I and J", () => {
    expect(toCaptionUpperCase("i\u0307\u0300 j\u0307 į\u0307", "lt")).toBe("I\u0300 J Į");
    expect(toCaptionUpperCase("i\u0307", "en")).toBe("I\u0307");
  });

  test("Greek capitals drop accents, keep the dialytika a lost accent needs, and keep the tonos of ή", () => {
    expect(toCaptionUpperCase("Μάιος προϊόν άλφα ευρώ ἄνθρωπος ᾠδή", "el")).toBe("ΜΑΪΟΣ ΠΡΟΪΟΝ ΑΛΦΑ ΕΥΡΩ ΑΝΘΡΩΠΟΣ ΩΙΔΗ");
    expect(toCaptionUpperCase("ναι ή όχι", "el")).toBe("ΝΑΙ Ή ΟΧΙ");
    expect(toCaptionUpperCase("café άλφα", "el")).toBe("CAFÉ ΑΛΦΑ");
    expect(toCaptionUpperCase("άλφα", "en")).toBe("ΆΛΦΑ");
  });

  test("other languages use the language-neutral mapping", () => {
    expect(toCaptionUpperCase("straße", "de")).toBe("STRASSE");
    expect(toCaptionUpperCase("ĳs", "nl")).toBe("ĲS");
    expect(toCaptionUpperCase("хорошо", "uk")).toBe("ХОРОШО");
    expect(toCaptionUpperCase("çava", "fr")).toBe("ÇAVA");
  });

  test("never reads the runtime's locale data", () => {
    const { toLocaleUpperCase, toLocaleLowerCase } = String.prototype;
    const refuse = () => {
      throw new Error("locale casing");
    };
    String.prototype.toLocaleUpperCase = refuse;
    String.prototype.toLocaleLowerCase = refuse;
    try {
      for (const language of ["tr", "az", "lt", "el", "de", "en", null]) {
        toCaptionUpperCase("istanbul Μάιος i\u0307", language);
        toCaptionLowerCase("ISTANBUL İ", language);
      }
    } finally {
      String.prototype.toLocaleUpperCase = toLocaleUpperCase;
      String.prototype.toLocaleLowerCase = toLocaleLowerCase;
    }
  });
});

describe("toCaptionLowerCase", () => {
  test("Turkish and Azerbaijani lower I to dotless ı and İ to i", () => {
    for (const language of ["tr", "az"]) {
      expect(toCaptionLowerCase("ISTANBUL İYİ", language)).toBe("ıstanbul iyi");
    }
  });

  test("other languages use the language-neutral mapping", () => {
    expect(toCaptionLowerCase("ISTANBUL", "en")).toBe("istanbul");
    expect(toCaptionLowerCase("ISTANBUL")).toBe("istanbul");
    expect(toCaptionLowerCase("ΟΔΟΣ", "el")).toBe("οδος");
    expect(toCaptionLowerCase("ПРИВЕТ", "ru")).toBe("привет");
  });
});

describe("stripCaptionEdgePunctuation", () => {
  test("strips edges of ASCII, CJK, Arabic, Indic, Ethiopic and Armenian punctuation", () => {
    expect(stripCaptionEdgePunctuation("don't,")).toBe("don't");
    expect(stripCaptionEdgePunctuation("state-of-the-art.")).toBe("state-of-the-art");
    expect(stripCaptionEdgePunctuation("...")).toBe("");
    expect(stripCaptionEdgePunctuation("「好」。")).toBe("好");
    expect(stripCaptionEdgePunctuation("کیا؟")).toBe("کیا");
    expect(stripCaptionEdgePunctuation("ہے۔")).toBe("ہے");
    expect(stripCaptionEdgePunctuation("है।")).toBe("है");
    expect(stripCaptionEdgePunctuation("ሰላም።")).toBe("ሰላም");
    expect(stripCaptionEdgePunctuation("բարեւ։")).toBe("բարեւ");
    expect(stripCaptionEdgePunctuation("«bonjour»")).toBe("bonjour");
    expect(stripCaptionEdgePunctuation("τι\u037E")).toBe("τι");
    expect(stripCaptionEdgePunctuation("50%")).toBe("50%");
  });
});
