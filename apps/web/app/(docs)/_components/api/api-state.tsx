"use client";

import { createContext, type ReactNode, type RefObject, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ExampleResponse } from "./examples";
import { persistedString } from "./persisted";
import type { RequestSpec } from "./snippets";

// The language is a preference, so it outlives the tab. The API key is a
// credential: it lives for the tab only and never appears in a page snippet.
const language = persistedString("local", "narriflow-docs-api-language", "typescript");
const token = persistedString("session", "narriflow-docs-api-key", "");

/** `nf_…abcd`: enough to recognise a key, never enough to leak it. */
export function maskToken(value: string): string {
  if (value.length <= 8) return value ? "…" : "";
  return `${value.startsWith("nf_") ? "nf_" : ""}…${value.slice(-4)}`;
}

interface ApiState {
  spec: RequestSpec;
  title: string;
  /** Example responses, highlighted on the server once for the page and the playground. */
  responses: ExampleResponse[];
  language: string;
  setLanguage: (id: string) => void;
  /** The API key the visitor entered, kept for this tab. */
  token: string;
  setToken: (value: string) => void;
  status: string;
  setStatus: (code: string) => void;
  playgroundOpen: boolean;
  setPlaygroundOpen: (open: boolean) => void;
  /** The "Try it" button, where focus returns when the playground closes. */
  opener: RefObject<HTMLButtonElement | null>;
}

const ApiContext = createContext<ApiState | null>(null);

export function useApiState(): ApiState {
  const state = useContext(ApiContext);
  if (!state) throw new Error("useApiState needs an <ApiProvider>");
  return state;
}

/** Shared choices of one endpoint page: code language, response status, API key, playground. */
export function ApiProvider({
  spec,
  title,
  responses,
  defaultStatus,
  children,
}: {
  spec: RequestSpec;
  title: string;
  responses: ExampleResponse[];
  defaultStatus: string;
  children: ReactNode;
}) {
  const currentLanguage = useSyncExternalStore(language.subscribe, language.get, () => language.fallback);
  const currentToken = useSyncExternalStore(token.subscribe, token.get, () => token.fallback);
  const [status, setStatus] = useState(defaultStatus);
  const [playgroundOpen, setPlaygroundOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);

  const setLanguage = useCallback((id: string) => language.set(id), []);
  const setToken = useCallback((value: string) => token.set(value), []);

  const value = useMemo(
    () => ({
      spec,
      title,
      responses,
      language: currentLanguage,
      setLanguage,
      token: currentToken,
      setToken,
      status,
      setStatus,
      playgroundOpen,
      setPlaygroundOpen,
      opener,
    }),
    [spec, title, responses, currentLanguage, setLanguage, currentToken, setToken, status, playgroundOpen],
  );
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}
