"use client"

import { useState } from "react"
import createCache from "@emotion/cache"
import { CacheProvider } from "@emotion/react"
import { useServerInsertedHTML } from "next/navigation"
import { ChakraProvider } from "@chakra-ui/react"
import { ColorModeProvider } from "./components/color-mode"
import { system } from "./theme"

/**
 * Emotion SSR registry for the App Router. Without it, styles first used
 * inside a streamed Suspense chunk are emitted as inline <style> tags in the
 * HTML stream, which React 19 sees as unexpected DOM during hydration —
 * hydration fails and the tree regenerates on the client (observed on
 * /projects, the one route that streams). `compat = true` disables emotion's
 * per-element inline insertion; useServerInsertedHTML hands each flush's CSS
 * to Next, which injects it hydration-safely.
 */
function EmotionRegistry({ children }: { children: React.ReactNode }) {
  const [{ cache, flush }] = useState(() => {
    const cache = createCache({ key: "cha" })
    cache.compat = true
    const prevInsert = cache.insert
    let inserted: string[] = []
    cache.insert = (...args) => {
      const serialized = args[1]
      if (cache.inserted[serialized.name] === undefined) {
        inserted.push(serialized.name)
      }
      return prevInsert(...args)
    }
    const flush = () => {
      const prev = inserted
      inserted = []
      return prev
    }
    return { cache, flush }
  })

  useServerInsertedHTML(() => {
    const names = flush()
    if (names.length === 0) return null
    let styles = ""
    for (const name of names) {
      const css = cache.inserted[name]
      // Global styles insert `true` instead of a CSS string — skip those.
      if (typeof css === "string") {
        styles += css
      }
    }
    return (
      <style
        key={cache.key}
        data-emotion={`${cache.key} ${names.join(" ")}`}
        /* biome-ignore lint/security/noDangerouslySetInnerHtml: Emotion SSR injects framework-generated CSS from the local cache. */
        dangerouslySetInnerHTML={{ __html: styles }}
      />
    )
  })

  return <CacheProvider value={cache}>{children}</CacheProvider>
}

export function Provider({ children }: { children: React.ReactNode }) {
  return (
    <EmotionRegistry>
      <ColorModeProvider>
        <ChakraProvider value={system}>{children}</ChakraProvider>
      </ColorModeProvider>
    </EmotionRegistry>
  )
}
