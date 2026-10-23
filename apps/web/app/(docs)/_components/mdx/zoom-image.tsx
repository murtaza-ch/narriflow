"use client";

import { type ComponentPropsWithoutRef, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { chakra } from "@chakra-ui/react";

/** The browser's own modal: Escape closes it (and traps focus); so does a click. */
function Viewer({ src, alt, onClose }: { src?: string | Blob; alt: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current?.showModal(), []);
  return (
    <chakra.dialog
      ref={dialog}
      m="auto"
      p="0"
      maxW="calc(100vw - 32px)"
      maxH="calc(100vh - 32px)"
      bg="transparent"
      cursor="zoom-out"
      css={{ "&::backdrop": { background: "var(--chakra-colors-bg-scrim)" } }}
      aria-label={alt || "Enlarged image"}
      onClose={onClose}
      onClick={onClose}
    >
      <chakra.img src={src} alt={alt} maxW="full" maxH="calc(100vh - 32px)" borderRadius="12px" />
    </chakra.dialog>
  );
}

/** Markdown images, rounded, and a button that enlarges them. */
export function ZoomImage({ alt = "", src }: ComponentPropsWithoutRef<"img">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <chakra.button type="button" display="block" maxW="full" cursor="zoom-in" onClick={() => setOpen(true)} aria-label={`Enlarge image${alt ? `: ${alt}` : ""}`}>
        <chakra.img src={src} alt={alt} maxW="full" h="auto" borderRadius="12px" />
      </chakra.button>
      {open ? createPortal(<Viewer src={src} alt={alt} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}
