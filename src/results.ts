import { Context, ExecuteResultAction, Result } from "@wox-launcher/wox-plugin"
import { favoritesGroupScore, launcherGroupScore, sourceLabel } from "./game"
import { ACTION_COPY, ACTION_FOLDER, ACTION_LAUNCH, ACTION_OPEN, ACTION_STAR, ACTION_UNSTAR, FALLBACK_ICON, imageOf } from "./icons"
import { InstalledGame } from "./types"

export interface ResultHooks {
  launch: (ctx: Context, game: InstalledGame) => Promise<void>
  open: (ctx: Context, target: string) => Promise<void>
  copy: (ctx: Context, text: string) => Promise<void>
  isFavorite: (id: string) => boolean
  favorite: (ctx: Context, id: string) => Promise<void>
}

export interface BuildResultOptions {
  group?: boolean
}

export function resultIcon(game: InstalledGame) {
  if (!game.iconPath) return FALLBACK_ICON
  // Shortcut icons are .ico files. Wox renders those through the system icon, which is the same image as the desktop shortcut.
  const imageType = game.iconType || (/\.ico$/i.test(game.iconPath) ? "fileicon" : "absolute")
  return imageOf(imageType === "svg" || imageType === "absolute" || imageType === "emoji" || imageType === "fileicon" ? imageType : "absolute", game.iconPath)
}

export function buildResult(game: InstalledGame, score: number, hooks: ResultHooks, options: BuildResultOptions = {}): Result {
  const context = { id: game.id, appid: game.appid }
  const actions: ExecuteResultAction[] = [
    {
      Id: `launch-${game.appid}`,
      Name: "i18n:action_launch",
      Icon: ACTION_LAUNCH,
      IsDefault: true,
      ContextData: context,
      Action: async ctx => hooks.launch(ctx, game)
    }
  ]
  if (game.installDir) {
    actions.push({
      Id: `folder-${game.appid}`,
      Name: "i18n:action_open_folder",
      Icon: ACTION_FOLDER,
      ContextData: context,
      Action: async ctx => hooks.open(ctx, game.installDir)
    })
  }
  if (game.storeUrl) {
    actions.push({
      Id: `store-${game.appid}`,
      Name: "i18n:action_open_store",
      Icon: ACTION_OPEN,
      ContextData: context,
      Action: async ctx => hooks.open(ctx, game.storeUrl)
    })
  }
  actions.push({
    Id: `copy-${game.appid}`,
    Name: "i18n:action_copy_name",
    Icon: ACTION_COPY,
    ContextData: context,
    Action: async ctx => hooks.copy(ctx, game.name)
  })
  const favorite = hooks.isFavorite(game.id)
  actions.splice(1, 0, {
    Id: `favorite-${game.appid}`,
    Name: favorite ? "i18n:action_unfavorite" : "i18n:action_favorite",
    Icon: favorite ? ACTION_UNSTAR : ACTION_STAR,
    PreventHideAfterAction: true,
    ContextData: context,
    Action: async ctx => hooks.favorite(ctx, game.id)
  })
  const result: Result = {
    Id: game.id,
    Title: game.name,
    // The group header already names the launcher. Keep it on a favorite row because that group is only "Favorites".
    SubTitle: options.group && !favorite ? "" : sourceLabel(game.source),
    Icon: resultIcon(game),
    Score: score,
    ScoreKey: game.id,
    Actions: actions,
    Tails: favorite ? [{ Type: "image", Image: ACTION_STAR, Tooltip: "i18n:group_favorites" }] : []
  }
  if (options.group) {
    result.Group = favorite ? "i18n:group_favorites" : sourceLabel(game.source)
    result.GroupScore = favorite ? favoritesGroupScore() : launcherGroupScore(game.source)
  }
  return result
}
