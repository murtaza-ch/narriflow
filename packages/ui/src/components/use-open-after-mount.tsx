"use client"

import { useEffect, useState } from "react"

/**
 * Opens a Dialog one effect after it mounts. A Chakra/Zag Dialog that mounts
 * already open under React StrictMode (the dev default) double-registers its
 * pointer-blocking layer, so closing it leaves `pointer-events: none` on the
 * body and `aria-hidden` on the app root. Mounting closed and opening in an
 * effect registers the layer once. Use it for every Dialog that mounts open:
 * `open={useOpenAfterMount(true)}`.
 */
export function useOpenAfterMount(open: boolean): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  return open && mounted
}
