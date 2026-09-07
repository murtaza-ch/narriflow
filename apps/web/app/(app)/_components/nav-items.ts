import {
  Bot,
  CalendarDays,
  Download,
  FolderOpen,
  House,
  PlugZap,
  Palette,
  type LucideIcon,
} from "lucide-react";

/**
 * Single source of truth for the app shell navigation (sidebar + mobile
 * drawer). Pure data — render concerns (active state, icon size) belong to
 * the consuming component.
 */
export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Home", href: "/home", icon: House },
  { label: "Projects", href: "/projects", icon: FolderOpen },
  { label: "Exports", href: "/exports", icon: Download },
  { label: "Calendar", href: "/calendar", icon: CalendarDays },
  { label: "Autopilot", href: "/autopilot", icon: Bot },
  { label: "Brand kit", href: "/brand-kit", icon: Palette },
  { label: "Integrations", href: "/integrations", icon: PlugZap },
];
