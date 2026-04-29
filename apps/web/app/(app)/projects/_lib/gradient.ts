const PALETTE = [
  { from: "#1E1B4B", to: "#7C3AED", name: "indigo-violet" },
  { from: "#0F172A", to: "#0D9488", name: "slate-teal" },
  { from: "#1C1917", to: "#D97706", name: "charcoal-amber" },
  { from: "#18181B", to: "#DB2777", name: "ink-magenta" },
  { from: "#0C1F1A", to: "#10B981", name: "forest-emerald" },
  { from: "#1E293B", to: "#3B82F6", name: "midnight-azure" },
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
