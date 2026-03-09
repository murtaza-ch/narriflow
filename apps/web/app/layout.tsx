import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ClerkProvider } from "@clerk/nextjs";
import { Provider } from "@narriflow/ui/provider";
import { Toaster } from "@narriflow/ui/components/toaster";
import { validateCoreEnv } from "../lib/env";

export const metadata: Metadata = {
  title: "Narriflow",
  description: "AI content repurposing platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  validateCoreEnv();

  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body>
        <Provider>
          <ClerkProvider>{children}</ClerkProvider>
          <Toaster />
        </Provider>
      </body>
    </html>
  );
}
