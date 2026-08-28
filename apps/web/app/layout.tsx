import type { Metadata } from "next";
import Script from "next/script";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import {
  Archivo,
  Montserrat,
  Bebas_Neue,
  Roboto,
  Oswald,
  Open_Sans,
  Anton,
} from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Provider } from "@narriflow/ui/provider";
import { Toaster } from "@narriflow/ui/components/toaster";
import { billingService } from "@narriflow/services";
import { validateCoreEnv } from "../lib/env";

const metadataDescription =
  "Turn long videos into short, captioned, virality-scored clips — plus repurposing, dubbing, and social publishing.";

function getMetadataBase() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (!appUrl) {
    return new URL("http://localhost:3000");
  }

  try {
    return new URL(appUrl);
  } catch {
    return new URL("http://localhost:3000");
  }
}

const display = Archivo({
  subsets: ["latin"],
  variable: "--font-display",
  axes: ["wdth"],
});

// Caption presets (packages/validators/src/caption-preset.ts) name Google
// Fonts that the worker bundles for burn-in (apps/worker/Dockerfile) but the
// browser never had a reason to load — so every preset used to preview in a
// fallback system font. Loading them here (as CSS variables, resolved by
// studio/_components/caption-style-engine.tsx) makes preview match export.
// Only the weights the presets actually use are pulled in to keep this lean;
// Bebas Neue and Anton are single-weight display faces (400 only).
//
// `preload: false` on every caption face is deliberate. The variables are
// declared on <html> so the studio can resolve them, but the faces are only
// ever *used* inside the studio — and next/font preloads a root-layout font on
// every route, which would ship ~10 unused woff2 preloads on the marketing and
// landing pages. Without preload the face still self-hosts and `display:"swap"`
// swaps it in on first use in the studio.
const captionMontserrat = Montserrat({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-caption-montserrat",
  display: "swap",
  preload: false,
});
const captionBebasNeue = Bebas_Neue({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-caption-bebas-neue",
  display: "swap",
  preload: false,
});
const captionRoboto = Roboto({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-caption-roboto",
  display: "swap",
  preload: false,
});
const captionOswald = Oswald({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-caption-oswald",
  display: "swap",
  preload: false,
});
const captionOpenSans = Open_Sans({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-caption-open-sans",
  display: "swap",
  preload: false,
});
// "Impact" is proprietary, so the worker substitutes Anton for burn-in
// (apps/worker/src/tasks/render-clips.ts: `Impact: "Anton"`) — mirror that
// mapping so an "Impact" preset previews as what will actually be exported.
const captionAnton = Anton({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-caption-anton",
  display: "swap",
  preload: false,
});

const captionFontVariables = [
  captionMontserrat.variable,
  captionBebasNeue.variable,
  captionRoboto.variable,
  captionOswald.variable,
  captionOpenSans.variable,
  captionAnton.variable,
].join(" ");

export const metadata: Metadata = {
  metadataBase: getMetadataBase(),
  title: {
    default: "Narriflow",
    template: "%s · Narriflow",
  },
  description: metadataDescription,
  openGraph: {
    type: "website",
    siteName: "Narriflow",
    title: "Narriflow",
    description: metadataDescription,
    url: "/",
    images: [{ url: "/opengraph-image" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Narriflow",
    description: metadataDescription,
    images: ["/opengraph-image"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  validateCoreEnv();
  billingService.validateConfiguration();

  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} ${display.variable} ${captionFontVariables}`}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        <Script id="narriflow-theme" strategy="beforeInteractive">
          {`(() => {
            try {
              const stored = localStorage.getItem("theme");
              const mode = stored === "light" || stored === "dark"
                ? stored
                : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
              const root = document.documentElement;
              root.classList.remove("light", "dark");
              root.classList.add(mode);
              root.style.colorScheme = mode;
            } catch {}
          })();`}
        </Script>
        <Provider>
          <ClerkProvider>{children}</ClerkProvider>
          <Toaster />
        </Provider>
      </body>
    </html>
  );
}
