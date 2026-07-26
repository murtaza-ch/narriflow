import {
  Bot,
  CreditCard,
  FolderOpen,
  LayoutDashboard,
  Palette,
  Settings,
  Share2,
  Upload,
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
  section: "studio" | "workspace";
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, section: "studio" },
  { label: "Projects", href: "/projects", icon: FolderOpen, section: "studio" },
  { label: "Upload", href: "/upload", icon: Upload, section: "studio" },
  { label: "Autopilot", href: "/autopilot", icon: Bot, section: "studio" },
  { label: "Brand templates", href: "/settings/brand-templates", icon: Palette, section: "workspace" },
  { label: "Social", href: "/settings/social", icon: Share2, section: "workspace" },
  { label: "Billing", href: "/settings/billing", icon: CreditCard, section: "workspace" },
  { label: "Settings", href: "/settings", icon: Settings, section: "workspace" },
];
