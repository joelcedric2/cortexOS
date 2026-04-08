import type { SlotManager } from "../controller/slot-manager.js";
import type { AgentRole } from "../agents/roles.js";
import type { MessageBus } from "./message-bus.js";

export interface RouteTarget {
  slot: number;
  role: AgentRole;
  paneId: string;
}

/**
 * Routes messages to the correct agent/slot based on role, slot, or @mentions.
 */
export class MessageRouter {
  constructor(
    private readonly messageBus: MessageBus,
    private readonly slotManager: SlotManager,
  ) {}

  /** Direct slot-to-slot routing. */
  async routeBySlot(
    fromSlot: number,
    toSlot: number,
    content: string,
  ): Promise<void> {
    await this.messageBus.send(fromSlot, toSlot, content);
  }

  /** Route to the first slot running a given role. */
  async routeByRole(
    fromSlot: number,
    targetRole: AgentRole,
    content: string,
  ): Promise<void> {
    const target = this.slotManager.findSlotByRole(targetRole);
    if (!target || !target.occupied) {
      throw new Error(`No agent with role "${targetRole}" is active`);
    }
    await this.messageBus.send(fromSlot, target.slotIndex, content);
  }

  /** Shortcut: route to the System Designer at slot 0. */
  async routeToDesigner(fromSlot: number, content: string): Promise<void> {
    await this.messageBus.send(fromSlot, 0, content);
  }

  /**
   * Parse content for @mentions (e.g. @backend, @security) and route
   * to the matching role. Falls back to System Designer (slot 0).
   */
  async autoRoute(fromSlot: number, content: string): Promise<void> {
    const mentionMatch = content.match(/@(\S+)/);
    if (mentionMatch) {
      const mentionedRole = mentionMatch[1] as AgentRole;
      const target = this.slotManager.findSlotByRole(mentionedRole);
      if (target?.occupied) {
        await this.messageBus.send(fromSlot, target.slotIndex, content);
        return;
      }
    }
    // No @mention or mentioned role not active — route to System Designer
    await this.messageBus.send(fromSlot, 0, content);
  }
}
