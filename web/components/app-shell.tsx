"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_ALL, NAV_MORE, NAV_PRIMARY, isActive, type NavItem } from "@/lib/nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

function titleFor(pathname: string): string {
  return NAV_ALL.find((n) => isActive(pathname, n.href))?.label ?? "Orbit";
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icons/icon.svg" alt="" className="size-7" />
      <span className="text-lg">Orbit</span>
    </Link>
  );
}

/** M3 bottom-bar item: icon inside a pill indicator, label below. */
function BottomItem({ item, active }: { item: Pick<NavItem, "label" | "icon">; active: boolean }) {
  const Icon = item.icon;
  return (
    <>
      <span
        className={cn(
          "flex h-8 w-16 items-center justify-center rounded-full transition-colors",
          active ? "bg-secondary text-secondary-foreground" : "text-muted-foreground",
        )}
      >
        <Icon className="size-5" />
      </span>
      <span className={cn("text-[11px] font-medium", active ? "text-foreground" : "text-muted-foreground")}>
        {item.label}
      </span>
    </>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = NAV_MORE.some((n) => isActive(pathname, n.href));

  return (
    <div className="min-h-dvh md:pl-64">
      {/* >= md: navigation drawer with all items */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col gap-1 bg-sidebar px-3 pb-4 pt-[calc(env(safe-area-inset-top)+1.25rem)] md:flex">
        <div className="px-3 pb-4">
          <Brand />
        </div>
        <nav className="flex flex-1 flex-col gap-1" aria-label="Main">
          {NAV_ALL.map((item) => {
            const active = isActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-12 items-center gap-3 rounded-full px-4 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50",
                )}
              >
                <Icon className="size-5" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="px-1">
          <ThemeToggle />
        </div>
      </aside>

      {/* mobile: top app bar */}
      <header className="sticky top-0 z-20 box-content flex h-14 items-center justify-between bg-background/90 px-4 pt-[env(safe-area-inset-top)] backdrop-blur md:hidden">
        <span className="text-xl font-medium tracking-tight">{titleFor(pathname)}</span>
        <ThemeToggle />
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-4 md:px-8 md:pb-12 md:pt-8">
        {children}
      </main>

      {/* mobile: bottom navigation bar */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 flex bg-surface-container px-2 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden"
      >
        {NAV_PRIMARY.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className="flex flex-1 flex-col items-center gap-1"
            >
              <BottomItem item={item} active={active} />
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          className="flex flex-1 flex-col items-center gap-1"
        >
          <BottomItem item={{ label: "More", icon: Menu }} active={moreActive} />
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="rounded-t-3xl pb-[max(1rem,env(safe-area-inset-bottom))] md:hidden">
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
            <SheetDescription className="sr-only">Additional pages</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-1 px-3 pb-2">
            {NAV_MORE.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    "flex h-12 items-center gap-3 rounded-full px-4 text-sm font-medium",
                    active ? "bg-secondary text-secondary-foreground" : "hover:bg-muted",
                  )}
                >
                  <Icon className="size-5" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
