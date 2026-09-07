// Graphite duotones (Blueline): placeholder art drawn from the graphite ramp
// (#0E1013 → #3E4756 family) with a single ultramarine variant as the one
// signal color. Values are the sanctioned mode-invariant media-ground hexes.
const PALETTE = [
  { from: "#0E1013", to: "#242A33", name: "graphite-carbon" },
  { from: "#14171C", to: "#303845", name: "graphite-slate" },
  { from: "#0E1013", to: "#3E4756", name: "graphite-steel" },
  { from: "#171B21", to: "#303845", name: "graphite-iron" },
  { from: "#14171C", to: "#242A33", name: "graphite-smoke" },
  { from: "#101347", to: "#1C2CC4", name: "ultramarine" },
] as const;

export type Gradient = (typeof PALETTE)[number];

export function gradientForId(id: string): Gradient {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? PALETTE[0];
}
