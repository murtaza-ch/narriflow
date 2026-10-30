import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { captionOmissionNote } from "@/lib/caption-omissions";
import { CaptionOmissionDetails, CaptionOmissionNoteButton } from "./caption-omission-note";

const STUDIO = "/projects/p/clips/c/studio";
const render = (node: React.ReactNode) => renderToStaticMarkup(<ChakraProvider value={system}>{node}</ChakraProvider>);

describe("clip row caption omission note", () => {
  test("renders nothing for a normal clip", () => {
    expect(render(<CaptionOmissionNoteButton diagnostics={null} studioHref={STUDIO} />)).not.toContain("couldn't be shown");
    expect(render(<CaptionOmissionNoteButton diagnostics={undefined} studioHref={STUDIO} />)).not.toContain("data-caption-omissions");
    expect(
      render(<CaptionOmissionNoteButton diagnostics={{ omittedCodePoints: [], skippedEmoji: [] }} studioHref={STUDIO} />),
    ).not.toContain("data-caption-omissions");
  });

  test("shows a neutral count when characters were left out", () => {
    const html = render(
      <CaptionOmissionNoteButton diagnostics={{ omittedCodePoints: ["U+13000", "U+13001"], skippedEmoji: [] }} studioHref={STUDIO} />,
    );
    expect(html).toContain("2 characters couldn&#x27;t be shown");
  });

  test("the popover lists every code point and offers Edit captions", () => {
    const note = captionOmissionNote({ omittedCodePoints: ["U+13000"], skippedEmoji: ["\u{1F1FA}\u{1F1F8}"] })!;
    const html = render(<CaptionOmissionDetails note={note} studioHref={STUDIO} />);
    expect(html).toContain("U+13000");
    expect(html).toContain("U+1F1FA U+1F1F8");
    expect(html).toContain("Edit captions");
    expect(html).toContain(`href="${STUDIO}"`);
  });
});
