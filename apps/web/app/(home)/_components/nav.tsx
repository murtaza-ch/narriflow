"use client";

import { type ComponentProps, type CSSProperties, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SignInLink, StartLink } from "./actions";
import { scrollToTarget, useIsoLayoutEffect } from "./motion";

const LINKS = [
  { label: "Product", href: "#product" },
  { label: "How it works", href: "#how" },
  { label: "Captions", href: "#captions" },
  { label: "Pricing", href: "#pricing" },
  { label: "API", href: "/developers/api" },
];

const SECTIONS = LINKS.flatMap((item) => (item.href.startsWith("#") ? [item.href] : []));

/** The app icon's three bars (app/icon.svg) beside the wordmark. */
export function Logo() {
  return (
    <span className="lx-logo">
      <svg viewBox="5 5 22 22" aria-hidden="true">
        <rect x="6" y="12" width="4.5" height="8" rx="2.25" fill="currentColor" />
        <rect className="lx-logo__mid" x="13.75" y="6" width="4.5" height="20" rx="2.25" />
        <rect x="21.5" y="10" width="4.5" height="12" rx="2.25" fill="currentColor" />
      </svg>
      Narriflow
    </span>
  );
}

/** Section links scroll smoothly in place; page links navigate. */
function NavLink({ href, onGo, ...props }: ComponentProps<"a"> & { href: string; onGo: (href: string) => void }) {
  if (!href.startsWith("#")) return <Link href={href} {...props} />;
  return (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onGo(href);
      }}
    />
  );
}

/**
 * Scroll state for the header: whether the page has left the top, and the
 * last section whose top has passed the middle of the screen.
 */
function useScrollState() {
  const [scrolled, setScrolled] = useState(false);
  const [section, setSection] = useState<string | null>(null);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      setScrolled(window.scrollY > 8);
      const line = window.innerHeight / 2;
      let current: string | null = null;
      for (const id of SECTIONS) {
        const top = document.querySelector(id)?.getBoundingClientRect().top;
        if (top !== undefined && top < line) current = id;
      }
      setSection(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return { scrolled, section };
}

/**
 * A floating capsule fixed to the top. It sits open on the hero's paper and
 * tightens into dark glass once the page scrolls. A lens slides between the
 * links: it follows the pointer and otherwise rests on the current section.
 */
export function Nav() {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const { scrolled, section } = useScrollState();
  const lensRef = useRef<HTMLSpanElement>(null);
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const target = hovered ?? section;

  useIsoLayoutEffect(() => {
    const lens = lensRef.current;
    const link = target ? linkRefs.current.get(target) : undefined;
    if (!lens) return;
    if (!link) {
      lens.classList.remove("is-on");
      return;
    }
    // Appearing: jump to the link and fade in. Already visible: slide to it.
    const appearing = !lens.classList.contains("is-on");
    if (appearing) lens.style.transition = "none";
    lens.style.setProperty("--x", `${link.offsetLeft}px`);
    lens.style.setProperty("--w", `${link.offsetWidth}px`);
    if (appearing) {
      void lens.offsetWidth;
      lens.style.transition = "";
    }
    lens.classList.add("is-on");
  }, [target]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  function go(href: string) {
    setOpen(false);
    if (href.startsWith("#")) scrollToTarget(href);
  }

  const state = [scrolled && "is-scrolled", open && "is-open"].filter(Boolean).join(" ");

  return (
    <header className={state ? `lx-header ${state}` : "lx-header"}>
      <div className="lx-nav">
        <div className="lx-nav__bar">
          <Link href="/" aria-label="Narriflow home" className="lx-nav__brand">
            <Logo />
          </Link>
          <nav className="lx-nav__links" aria-label="Main navigation" onPointerLeave={() => setHovered(null)}>
            <span ref={lensRef} className="lx-nav__lens" aria-hidden="true" />
            {LINKS.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                onGo={go}
                ref={(node) => {
                  if (node) linkRefs.current.set(item.href, node);
                  return () => {
                    linkRefs.current.delete(item.href);
                  };
                }}
                className={item.href === target ? "is-lit" : undefined}
                aria-current={item.href === section ? "location" : undefined}
                onPointerEnter={() => setHovered(item.href)}
                onFocus={() => setHovered(item.href)}
                onBlur={() => setHovered(null)}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="lx-nav__actions">
            <SignInLink className="lx-nav__signin" />
            <StartLink className="lx-nav__start">
              Start free
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" />
              </svg>
            </StartLink>
            <button
              type="button"
              className="lx-nav__burger"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              aria-controls="lx-nav-sheet"
              onClick={() => setOpen((value) => !value)}
            />
          </div>
        </div>
        <div className="lx-nav__sheet" id="lx-nav-sheet" inert={!open}>
          <div className="lx-nav__sheet-body">
            {LINKS.map((item, index) => (
              <NavLink
                key={item.href}
                href={item.href}
                onGo={go}
                aria-current={item.href === section ? "location" : undefined}
                style={{ "--i": index } as CSSProperties}
              >
                {item.label}
              </NavLink>
            ))}
            <SignInLink className="lx-nav__sheet-signin" />
          </div>
        </div>
      </div>
    </header>
  );
}
