"use client";

import { useShiki } from "fumadocs-core/highlight/client";
import { Suspense } from "react";
import { highlightOptions } from "./code-theme";

function Highlighted({ code, lang }: { code: string; lang: string }) {
  return useShiki(code, highlightOptions(lang));
}

/** Highlights in the browser, for code that changes as the visitor types. */
export function LiveCode({ code, lang }: { code: string; lang: string }) {
  return (
    <Suspense fallback={<pre>{code}</pre>}>
      <Highlighted code={code} lang={lang} />
    </Suspense>
  );
}
