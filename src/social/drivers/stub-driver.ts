/**
 * Stub drivers for platforms not yet implemented.
 *
 * Each throws `DriverNotImplemented` on every method call.
 * Phase 5 or the skill-loader will replace these with real drivers.
 */

import type {
  SocialDriver,
  SocialPlatform,
  SocialTransport,
  ResolvedTarget,
  SendOutcome,
} from "../driver.js";
import { DriverNotImplemented } from "../driver.js";

function makeStubDriver(
  platform: SocialPlatform,
  transport: SocialTransport,
): SocialDriver {
  return {
    platform,
    transport,
    loginCheck(): Promise<"logged-in" | "expired" | "never"> {
      throw new DriverNotImplemented(platform);
    },
    resolveTarget(_handle: string): Promise<ResolvedTarget> {
      throw new DriverNotImplemented(platform);
    },
    openConversation(_targetId: string): Promise<void> {
      throw new DriverNotImplemented(platform);
    },
    typeMessage(_msg: string): Promise<void> {
      throw new DriverNotImplemented(platform);
    },
    confirmAndSend(): Promise<SendOutcome> {
      throw new DriverNotImplemented(platform);
    },
  };
}

export const linkedinStub = makeStubDriver("linkedin", "cdp");
export const redditStub = makeStubDriver("reddit", "api");
export const tiktokStub = makeStubDriver("tiktok", "cdp");
export const discordStub = makeStubDriver("discord", "api");
export const telegramStub = makeStubDriver("telegram", "api");
export const whatsappStub = makeStubDriver("whatsapp", "applescript");
