import Link from "next/link";
import { SignupForm } from "./actions";
import type { CaptionStyle } from "./caption-styles";
import { ClosingVariants } from "./closing-variants";
import { FootageMark, RewindButton } from "./ending";
import { Logo } from "./nav";

/** The last call to action. Four variants are under review; see closing-variants.tsx. */
export function Closing({ styles, freeMinutes }: { styles: Record<string, CaptionStyle>; freeMinutes: number }) {
  return <ClosingVariants styles={styles} freeMinutes={freeMinutes} />;
}

const FOOTER_LINKS = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "/#how" },
      { label: "Caption styles", href: "/#captions" },
      { label: "Pricing", href: "/pricing" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "REST API", href: "/docs/api/introduction" },
      { label: "Connector", href: "/connector" },
    ],
  },
  {
    title: "Resources",
    links: [{ label: "Blog", href: "/blog" }],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

export function Footer({ freeMinutes }: { freeMinutes: number }) {
  return (
    <footer className="lx-footer">
      <div className="lx-footer__top lx-container">
        <div className="lx-footer__signup">
          <p className="lx-serif">Don&apos;t miss a moment</p>
          <span>Start with your email. Your first {freeMinutes} minutes every month are free.</span>
          <SignupForm />
        </div>
        <nav className="lx-footer__cols" aria-label="Footer">
          {FOOTER_LINKS.map((column) => (
            <div key={column.title}>
              <p>{column.title}</p>
              <ul>
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href}>{link.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <FootageMark />
      <div className="lx-footer__base lx-container">
        <span className="lx-footer__brand">
          <Logo />© {new Date().getFullYear()}
        </span>
        <span className="lx-footer__line">Made for people with something to say.</span>
        <RewindButton />
      </div>
    </footer>
  );
}
