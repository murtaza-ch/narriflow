"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useApiState } from "./api-state";
import type { PlaygroundProps } from "./playground";

// The playground and its highlighter load the first time someone opens it.
const Playground = dynamic(() => import("./playground").then((module) => module.Playground), { ssr: false });

export function PlaygroundHost(props: PlaygroundProps) {
  const { playgroundOpen } = useApiState();
  const [opened, setOpened] = useState(false);
  if (playgroundOpen && !opened) setOpened(true);
  return opened ? <Playground {...props} /> : null;
}
