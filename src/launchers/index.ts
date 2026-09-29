import { GameLauncher } from "../types"
import { BattleNetLauncher } from "./battlenet"
import { EaLauncher } from "./ea"
import { EpicLauncher } from "./epic"
import { GogLauncher } from "./gog"
import { ItchLauncher } from "./itch"
import { SteamLauncher } from "./steam"
import { UbisoftLauncher } from "./ubisoft"
import { XboxLauncher } from "./xbox"

export function createLaunchers(): GameLauncher[] {
  return [new SteamLauncher(), new EpicLauncher(), new GogLauncher(), new UbisoftLauncher(), new EaLauncher(), new BattleNetLauncher(), new XboxLauncher(), new ItchLauncher()]
}
