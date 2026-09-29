export const GLOBAL_RESULT_LIMIT = 20
export const CACHE_VERSION = 4
export const CACHE_FILE = "games.json"
export const FALLBACK_MS = 5 * 60 * 1000
export const EMPTY_RETRY_MS = 15 * 1000
export const WATCH_DEBOUNCE_MS = 2000
export const REG_TIMEOUT_MS = 3000
export const PLUGIN_VERSION = "0.0.6"
export const FAVORITES_KEY = "favorites"
export const FAVORITES_GROUP_SCORE = 1000

export const LAUNCHER_LABELS: Record<string, string> = {
  steam: "Steam",
  epic: "Epic",
  gog: "GOG",
  ubisoft: "Ubisoft Connect",
  ea: "EA",
  battlenet: "Battle.net",
  xbox: "Xbox",
  itch: "itch.io"
}

export const LAUNCHER_ORDER = ["steam", "epic", "gog", "ubisoft", "ea", "battlenet", "xbox", "itch"]
