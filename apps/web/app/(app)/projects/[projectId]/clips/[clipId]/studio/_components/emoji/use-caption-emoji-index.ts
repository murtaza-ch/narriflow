"use client";

import { useEffect, useState } from "react";

type CaptionEmojiIndexModule = typeof import("@narriflow/caption-emoji/index");

// The catalog index (129 kB) is a dynamic import, shared with the art loader and the picker, so it
// never enters the Studio's first chunks.
let loaded: CaptionEmojiIndexModule | null = null;
let loading: Promise<CaptionEmojiIndexModule> | null = null;

export function loadCaptionEmojiIndex(): Promise<CaptionEmojiIndexModule> {
  loading ??= import("@narriflow/caption-emoji/index").then((module) => {
    loaded = module;
    return module;
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** The catalog index once loaded; null until then (callers show the id-derived name meanwhile). */
export function useCaptionEmojiIndex(): CaptionEmojiIndexModule | null {
  const [module, setModule] = useState(loaded);
  useEffect(() => {
    if (module) return;
    let live = true;
    void loadCaptionEmojiIndex().then((value) => {
      if (live) setModule(value);
    });
    return () => {
      live = false;
    };
  }, [module]);
  return module;
}

/** An emoji's name for labels: the catalog's when loaded, else its id spelled out ("money-bag" is "Money bag"). */
export function captionEmojiName(index: CaptionEmojiIndexModule | null, id: string): string {
  const name = index?.captionEmojiById(id)?.name;
  if (name) return name;
  const words = id.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
