import type { AccountService } from "./accounts.ts";
import { isPlayerName, normalizeUuid, type MinecraftDirectory } from "./minecraft.ts";
import type { SkinService } from "./skins.ts";

export interface SyncAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface SkinSync {
  /** Handles "this player cleared their skin in the game". Safe to repeat: nothing left to delete is still a success. */
  clear(payload: Record<string, unknown>): Promise<SyncAnswer>;
}

/**
 * The Minecraft server is the only caller here, and the UUID is what it is sure about. A nickname is only ever used to
 * find the account the first time, and only when the server's own usercache.json agrees that the nickname and the UUID
 * belong together.
 */
export function createSkinSync(accounts: AccountService, skins: SkinService, directory: MinecraftDirectory): SkinSync {
  return {
    async clear(payload) {
      const uuid = normalizeUuid(payload["minecraftUuid"]);
      if (!uuid) {
        return { status: 400, body: { success: false, error: "invalid-uuid", message: "minecraftUuid must be a Minecraft UUID" } };
      }
      const claimedName = payload["minecraftUsername"];
      if (claimedName !== undefined && !isPlayerName(claimedName)) {
        return { status: 400, body: { success: false, error: "invalid-username", message: "minecraftUsername is not a Minecraft name" } };
      }

      let user = accounts.findByMinecraftUuid(uuid);
      if (!user) {
        // the server's own record wins; the request's nickname is only used when the server has no record yet
        const knownName = await directory.nameFor(uuid);
        const name = knownName ?? (isPlayerName(claimedName) ? claimedName : null);
        if (knownName && isPlayerName(claimedName) && knownName.toLowerCase() !== claimedName.toLowerCase()) {
          return { status: 409, body: { success: false, error: "uuid-name-mismatch", message: "The UUID and the name do not belong together" } };
        }
        if (name) {
          user = accounts.findByMinecraftUsername(name);
        }
        if (user && !accounts.linkMinecraftUuid(user.id, uuid)) {
          return { status: 409, body: { success: false, error: "uuid-taken", message: "This UUID is linked to another account" } };
        }
      }

      if (!user) {
        // nobody on the site plays under this UUID: nothing to do, and that is not a failure
        return { status: 200, body: { success: true, deleted: false, reason: "account_not_found" } };
      }

      const { deleted } = await skins.clear(user.id);
      console.info(`[skins] Minecraft cleared the skin of ${uuid}: ${deleted ? "removed from the site" : "the site had none"}`);
      return {
        status: 200,
        body: deleted ? { success: true, deleted: true } : { success: true, deleted: false, reason: "skin_not_found" },
      };
    },
  };
}
