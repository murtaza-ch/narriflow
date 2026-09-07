import type { MeterPalette } from "@narriflow/ui/components/meter";

/**
 * Shared meter-fill color logic — sidebar and mobile nav render the same
 * usage meter. Client-safe: keep this file free of server-only imports
 * (services, db) so "use client" components can import it.
 */
export function usagePalette(usagePct: number): MeterPalette {
  return usagePct >= 100 ? "danger" : usagePct >= 80 ? "warning" : "accent";
}
