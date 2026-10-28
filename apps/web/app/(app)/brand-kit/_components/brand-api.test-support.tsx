import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { BrandApiContext, type BrandApiValue } from "./brand-api";

/** Renders Brand Kit components against a stub API: reads and commands are never called by static markup. */
export function StubBrandApi({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient();
  const value = {
    scope: { userId: "user_1", workspaceId: "20000000-0000-4000-8000-000000000001" },
    queries: {},
    mutations: {},
    queryClient,
    invalidate: async () => {},
    createIntent: () => ({ keyFor: () => "key", complete: () => {} }),
  } as unknown as BrandApiValue;
  return (
    <QueryClientProvider client={queryClient}>
      <BrandApiContext.Provider value={value}>{children}</BrandApiContext.Provider>
    </QueryClientProvider>
  );
}
