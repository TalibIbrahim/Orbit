import type { MetadataRoute } from "next";
import { iconUrl } from "@/lib/icons";

// Icons are generated from app/icon.svg by `npm run icons` (scripts/generate-icons.mjs).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Orbit",
    short_name: "Orbit",
    description: "Self-hosted storage and server dashboard",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Dark theme surface (globals.css), so the splash screen and title bar match the dark UI.
    background_color: "#131314",
    theme_color: "#131314",
    icons: [
      { src: iconUrl("icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: iconUrl("icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
      { src: iconUrl("icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
