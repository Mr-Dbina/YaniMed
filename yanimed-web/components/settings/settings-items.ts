import { Bell, CircleGauge, Folder, Mic, Settings } from "lucide-react";
import { SunSlashIcon } from "@/components/icons/sun-slash-icon";

export interface MenuIconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

// Lucide components satisfy this, and so does the hand-authored SunSlashIcon.
export type MenuIcon = (props: MenuIconProps) => React.ReactNode;

export interface SettingsItem {
  label: string;
  icon: MenuIcon;
  href: string;
}

/**
 * Single source of truth for the settings destinations. The sidebar hover
 * dropdown and the settings left nav both render from this, so they cannot
 * drift apart.
 */
export const settingsItems: SettingsItem[] = [
  { label: "General", icon: Settings, href: "/settings/general" },
  { label: "Appearance", icon: SunSlashIcon, href: "/settings/appearance" },
  { label: "Notifications", icon: Bell, href: "/settings/notifications" },
  { label: "Voice", icon: Mic, href: "/settings/voice" },
  { label: "Storage", icon: Folder, href: "/settings/storage" },
  { label: "Personalization", icon: CircleGauge, href: "/settings/personalization" },
];
