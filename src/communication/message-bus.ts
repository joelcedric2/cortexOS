import type { TmuxManager } from "../tmux/tmux-manager.js";
import type { SlotManager } from "../controller/slot-manager.js";
import type { VectorStore } from "../memory/vector-store.js";

export interface AgentMessage {
  fromSlot: number;
  toSlot: number;
  content: string;
  timestamp: Date;
}

/**
 * Inter-agent messaging via tmux send-keys.
 * Messages are sent as structured text to the target agent's pane.
 */
export class MessageBus {
  private readonly messageLog: AgentMessage[] = [];

  constructor(
    private readonly tmux: TmuxManager,
    private readonly slotManager: SlotManager,
    private readonly vectorStore?: VectorStore,
  ) {}

  async send(fromSlot: number, toSlot: number, content: string): Promise<void> {
    const fromState = this.slotManager.getSlot(fromSlot);
    const toState = this.slotManager.getSlot(toSlot);

    if (!fromState || !toState) {
      throw new Error(`Invalid slot index: from=${fromSlot}, to=${toSlot}`);
    }
    if (!toState.occupied || !toState.sessionName) {
      throw new Error(`Slot ${toSlot} is not occupied`);
    }

    const fromRole = fromState.agentRole ?? `slot${fromSlot}`;
    const formatted = `\n[MSG from ${fromRole}@slot${fromSlot}]: ${content}\n`;

    await this.tmux.sendKeys(toState.sessionName, formatted);

    const message: AgentMessage = {
      fromSlot,
      toSlot,
      content,
      timestamp: new Date(),
    };
    this.messageLog.push(message);

    // Persist to pgvector if available
    if (this.vectorStore) {
      const toRole = toState.agentRole ?? `slot${toSlot}`;
      await this.vectorStore.storeMessage(String(fromRole), String(toRole), content);
    }
  }

  async broadcast(fromSlot: number, content: string): Promise<void> {
    const occupied = this.slotManager.getOccupiedSlots();
    const targets = occupied.filter((s) => s.slotIndex !== fromSlot);
    await Promise.all(
      targets.map((s) => this.send(fromSlot, s.slotIndex, content)),
    );
  }

  getHistory(slotFilter?: number): AgentMessage[] {
    if (slotFilter === undefined) {
      return [...this.messageLog];
    }
    return this.messageLog.filter(
      (m) => m.fromSlot === slotFilter || m.toSlot === slotFilter,
    );
  }

  clearHistory(): void {
    this.messageLog.length = 0;
  }
}
