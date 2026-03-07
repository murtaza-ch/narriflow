import type { Metadata } from "next";
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
    <html lang="en" suppressHydrationWarning>
      <body>
        <Provider>
          <ClerkProvider>{children}</ClerkProvider>
          <Toaster />
        </Provider>
      </body>
    </html>
  );
}
