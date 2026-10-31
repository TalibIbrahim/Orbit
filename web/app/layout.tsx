import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { AppShell } from "@/components/app-shell";
import { SwRegister } from "@/components/sw-register";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Orbit", template: "%s · Orbit" },
  description: "Self-hosted storage and server dashboard",
  applicationName: "Orbit",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Orbit" },
  // Tab / home-screen icons come from the app/ file conventions (all generated from app/icon.svg):
  //   icon.svg -> <link rel="icon" type="image/svg+xml">, favicon.ico (16/32/48), apple-icon.png (180).
  // Next.js adds a content hash to each URL, so a changed icon is never served stale.
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafd" },
    { media: "(prefers-color-scheme: dark)", color: "#131314" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full font-sans">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider>
            <AppShell>{children}</AppShell>
          </TooltipProvider>
          <Toaster />
          <SwRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}
