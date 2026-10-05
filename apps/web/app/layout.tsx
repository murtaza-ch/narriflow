import type { Metadata } from "next";
import { Suspense } from "react";
import Script from "next/script";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Archivo } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Provider } from "@narriflow/ui/provider";
import { Toaster } from "@narriflow/ui/components/toaster";
import { billingService } from "@narriflow/services";
import { validateCoreEnv } from "../lib/env";
import { AuthModal } from "./_components/auth/auth-modal";
import { captionFontVariables } from "./caption-fonts";

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
  billingService.validateConfiguration({ surface: "web" });

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
              const stored = localStorage.getItem("narriflow-color-mode");
              const mode = stored === "light" || stored === "dark"
                ? stored
                : "dark";
              const root = document.documentElement;
              root.classList.remove("light", "dark");
              root.classList.add(mode);
              root.style.colorScheme = mode;
            } catch {}
          })();`}
        </Script>
        <Provider>
          <ClerkProvider signInUrl="/?auth=sign-in" signUpUrl="/?auth=sign-up" signInFallbackRedirectUrl="/auth/continue" signUpFallbackRedirectUrl="/auth/continue">
            {children}
            <Suspense fallback={null}><AuthModal /></Suspense>
          </ClerkProvider>
          <Toaster />
        </Provider>
      </body>
    </html>
  );
}
