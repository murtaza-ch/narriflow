import { expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceThumb } from "./source-thumb";

test("project source poster renders the saved upload frame while import is queued", () => {
  const props = { projectId: "upload-project", title: "Selected video", sourceType: "upload", sourceInput: null, sourceMediaUrl: "", thumbnail: { small: "https://storage.example/frame.webp", large: null, expiresAt: "2030-01-01T00:00:00Z" } };
  const markup = renderToStaticMarkup(<ChakraProvider value={system}><SourceThumb {...props} /></ChakraProvider>);
  expect(markup).toContain('src="https://storage.example/frame.webp"');
  expect(markup).not.toContain("<video");
});
