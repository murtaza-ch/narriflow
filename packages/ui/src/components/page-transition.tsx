"use client"

import { motion, useReducedMotion } from "framer-motion"
import type { ReactNode } from "react"

interface PageTransitionProps {
  children: ReactNode
}

/**
 * PageTransition — fade-up page entrance. JS-driven (framer-motion), so it
 * checks prefers-reduced-motion itself via `useReducedMotion` — the CSS
 * kill-switch in globalCss cannot reach JS-set values.
 */
export function PageTransition({ children }: PageTransitionProps) {
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 10, filter: "blur(2px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: reduceMotion ? 0 : 0.45, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}
