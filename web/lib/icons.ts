/**
 * Cache-busting version for the PWA icons in public/icons (bump after `npm run icons`, together with
 * ICON_VERSION in public/sw.js). favicon.ico, icon.svg and apple-icon.png live in app/ and get a
 * content hash from Next.js automatically.
 */
export const ICON_VERSION = "2";
export const iconUrl = (file: string) => `/icons/${file}?v=${ICON_VERSION}`;
