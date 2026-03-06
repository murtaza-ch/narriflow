import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { validateCoreEnv } from "../lib/env";
import "./globals.css";

export const metadata: Metadata = {
  title: "Narriflow",
  description: "AI content repurposing platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  validateCoreEnv();

  return (
    <html lang="en">
      <body>
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
