import {
  BookMarked,
  Bot,
  CalendarDays,
  Download,
  FolderOpen,
  House,
  PlugZap,
  Palette,
  TrendingUp,
  Search,
  type LucideIcon,
} from "lucide-react";
import type { PlanFeature } from "@narriflow/validators";

/**
 * Single source of truth for the app shell navigation (sidebar + mobile
 * drawer). Pure data — render concerns (active state, icon size) belong to
 * the consuming component.
 */
export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Plan feature the page needs; the nav marks it with a gem when missing. */
  feature?: PlanFeature;
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Home", href: "/home", icon: House },
  { label: "Projects", href: "/projects", icon: FolderOpen },
  { label: "Search", href: "/search", icon: Search },
  { label: "Exports", href: "/exports", icon: Download },
  { label: "Calendar", href: "/calendar", icon: CalendarDays },
  { label: "What worked", href: "/performance", icon: TrendingUp },
  { label: "Autopilot", href: "/autopilot", icon: Bot, feature: "automation.autopilot" },
  { label: "Recipes", href: "/recipes", icon: BookMarked },
  { label: "Brand kit", href: "/brand-kit", icon: Palette, feature: "brand.profiles" },
  { label: "Integrations", href: "/integrations", icon: PlugZap },
];
