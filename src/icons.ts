import { WoxImage, WoxImageType } from "@wox-launcher/wox-plugin"

export const PLUGIN_ICON_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'><rect width='48' height='48' rx='12' fill='#7c3aed'/><path d='M10 21.5c0-4 4-7 9-7h10c5 0 9 3 9 7v5c0 4-3 7-7 7h-1l-3-3H21l-3 3h-1c-4 0-7-3-7-7z' fill='#f5f3ff'/><path d='M17 24.5h6M20 21.5v6' stroke='#7c3aed' stroke-width='2' stroke-linecap='round'/><circle cx='30' cy='23.5' r='1.5' fill='#7c3aed'/><circle cx='34' cy='26.5' r='1.5' fill='#7c3aed'/></svg>"

export const FALLBACK_ICON: WoxImage = { ImageType: "svg", ImageData: PLUGIN_ICON_SVG }

export const ACTION_LAUNCH: WoxImage = {
  ImageType: "svg",
  ImageData:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--wox-theme-icon-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5h5.5L9 22l10-13h-6z"/></svg>'
}

export const ACTION_OPEN: WoxImage = {
  ImageType: "svg",
  ImageData:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--wox-theme-icon-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5h5v5M19 5l-9 9"/><path d="M13 7H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-7"/></svg>'
}

export const ACTION_FOLDER: WoxImage = {
  ImageType: "svg",
  ImageData:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--wox-theme-icon-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
}

export const ACTION_COPY: WoxImage = {
  ImageType: "svg",
  ImageData:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--wox-theme-icon-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>'
}

export const ACTION_STAR: WoxImage = {
  ImageType: "svg",
  ImageData:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--wox-theme-icon-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.6 5.4 6 .9-4.3 4.2 1 5.9L12 16.8 6.7 19.4l1-5.9L3.4 9.3l6-.9z"/></svg>'
}

export const ACTION_UNSTAR: WoxImage = {
  ImageType: "svg",
  ImageData:
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--wox-theme-icon-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.6 5.4 6 .9-4.3 4.2 1 5.9L12 16.8 6.7 19.4l1-5.9L3.4 9.3l6-.9z"/><path d="M5 5l14 14"/></svg>'
}

export function imageOf(type: WoxImageType | "fileicon", data: string): WoxImage {
  return { ImageType: type as unknown as WoxImageType, ImageData: data }
}
