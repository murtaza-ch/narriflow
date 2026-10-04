"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { Box } from "@chakra-ui/react";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Lights the blueprint grid under the pointer: an accent-coloured copy of the
 * grid, masked to a soft circle that follows the cursor across the parent.
 */
export function CursorGlow() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = ref.current;
    const host = layer?.parentElement;
    if (!layer || !host || reducedMotion()) return;
    const move = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      layer.style.setProperty("--mx", `${event.clientX - rect.left}px`);
      layer.style.setProperty("--my", `${event.clientY - rect.top}px`);
      layer.style.opacity = "1";
    };
    const leave = () => {
      layer.style.opacity = "0";
    };
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <Box
      ref={ref}
      aria-hidden="true"
      position="absolute"
      inset="0"
      pointerEvents="none"
      opacity="0"
      transition="opacity 500ms ease"
      style={{
        backgroundImage:
          "radial-gradient(260px circle at var(--mx) var(--my), color-mix(in srgb, var(--chakra-colors-accent-solid) 14%, transparent), transparent 70%), linear-gradient(to right, color-mix(in srgb, var(--chakra-colors-accent-solid) 45%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--chakra-colors-accent-solid) 45%, transparent) 1px, transparent 1px)",
        backgroundSize: "100% 100%, 28px 28px, 28px 28px",
        maskImage: "radial-gradient(220px circle at var(--mx) var(--my), black, transparent 75%)",
        WebkitMaskImage: "radial-gradient(220px circle at var(--mx) var(--my), black, transparent 75%)",
      }}
    />
  );
}

/** Pulls its child a few pixels toward the pointer, then springs back. */
export function Magnetic({ children, strength = 0.22 }: { children: ReactNode; strength?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || !window.matchMedia("(pointer: fine)").matches) return;
    const move = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      el.style.transform = `translate(${dx * strength}px, ${dy * strength}px)`;
    };
    const leave = () => {
      el.style.transform = "";
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [strength]);

  return (
    <Box ref={ref} display="inline-block" transition="transform 380ms cubic-bezier(0.2, 0.9, 0.3, 1.3)">
      {children}
    </Box>
  );
}
