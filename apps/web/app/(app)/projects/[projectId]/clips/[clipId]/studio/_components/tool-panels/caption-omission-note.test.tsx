import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { studioCaptionOmissionNote } from "@/lib/caption-omissions";
import { StudioCaptionOmissionNote } from "./caption-omission-note";

function documentWith(text: string, visible: boolean) {
  return editorDocumentSchema.parse({
    version: 1, clipStartSec: 0, clipEndSec: 4,
    captionPreset: captionPresetSchema.parse({ visible, textTransform: "none", wordsPerCue: 3 }),
    transcriptSlice: [{
      index: 0, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9, startSec: 0, endSec: 3, text,
      words: text.split(" ").map((word, index) => ({ word, startSec: index, endSec: index + 1, confidence: 0.9 })),
    }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null, deletedRanges: [],
  });
}

const render = (text: string, visible = true) =>
  renderToStaticMarkup(
    <ChakraProvider value={system}>
      <StudioCaptionOmissionNote note={studioCaptionOmissionNote(documentWith(text, visible))} />
    </ChakraProvider>,
  );

describe("Studio caption omission note", () => {
  test("is absent for drawable text and for hidden captions", () => {
    expect(render("Hello 你好 💰")).not.toContain("data-caption-omissions");
    expect(render("Hello \u{13000}", false)).not.toContain("data-caption-omissions");
  });

  test("names the characters and says what to do", () => {
    const html = render("Hello \u{13000} \u{13001}");
    expect(html).toContain("2 characters can&#x27;t be shown in exported captions");
    expect(html).toContain("U+13000, U+13001");
    expect(html).toContain("Edit the text");
  });
});
