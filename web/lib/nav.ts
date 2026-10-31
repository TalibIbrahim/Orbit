import {
  Archive,
  FolderOpen,
  HardDriveDownload,
  LayoutDashboard,
  type LucideIcon,
  PieChart,
  Server,
  Settings,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_PRIMARY: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/usage", label: "Usage", icon: PieChart },
  { href: "/folders", label: "Folders", icon: FolderOpen },
  { href: "/devices", label: "Devices", icon: Server },
];

export const NAV_MORE: NavItem[] = [
  { href: "/replication", label: "Replication", icon: HardDriveDownload },
  { href: "/backups", label: "Backups", icon: Archive },
  { href: "/settings", label: "Settings", icon: Settings },
];

export const NAV_ALL: NavItem[] = [...NAV_PRIMARY, ...NAV_MORE];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}
