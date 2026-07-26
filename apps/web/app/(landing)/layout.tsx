import type { ReactNode } from "react";

// Landing-page lab: each variant under /lp/* owns its full chrome (nav,
// footer, scroll behavior), so this layout stays deliberately empty.
export default function LandingLayout({ children }: { children: ReactNode }) {
  return children;
}
