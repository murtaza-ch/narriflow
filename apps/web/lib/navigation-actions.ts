import type { LucideIcon } from "lucide-react";
import { Braces, CircleHelp, KeyRound, PlugZap } from "lucide-react";

export interface NavigationAction {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  keywords: string[];
  icon: LucideIcon;
}

export const NAVIGATION_ACTIONS: NavigationAction[] = [
  {
    id: "integrations",
    title: "Integrations",
    subtitle: "AI clients, social accounts, and developer access",
    href: "/integrations",
    keywords: ["connect", "apps", "social", "developer"],
    icon: PlugZap,
  },
  {
    id: "mcp",
    title: "Connect an AI assistant",
    subtitle: "Set up Narriflow MCP with Codex, Claude, ChatGPT, or another client",
    href: "/integrations/mcp",
    keywords: ["mcp", "codex", "claude", "chatgpt", "inspector", "oauth"],
    icon: Braces,
  },
  {
    id: "developer-access",
    title: "Developer access",
    subtitle: "Create and revoke scoped workspace API keys",
    href: "/settings/api",
    keywords: ["api", "key", "token", "credential", "revoke"],
    icon: KeyRound,
  },
  {
    id: "help",
    title: "Tutorials & help",
    subtitle: "Guides for projects, publishing, and AI assistants",
    href: "/help",
    keywords: ["guide", "tutorial", "support", "setup"],
    icon: CircleHelp,
  },
];

export function matchNavigationActions(query: string): NavigationAction[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return NAVIGATION_ACTIONS.slice(0, 3);

  return NAVIGATION_ACTIONS.filter((action) => {
    const haystack = [action.title, action.subtitle, ...action.keywords]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
