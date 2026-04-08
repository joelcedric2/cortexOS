import type { AgentRole } from "../agents/roles.js";
import type { AgentProvider } from "../agents/agent.js";

export interface SlotState {
  slotIndex: number;
  occupied: boolean;
  agentRole: AgentRole | null;
  provider: AgentProvider | null;
  sessionName: string | null;
  startedAt: Date | null;
}

export interface EvictionResult {
  slotIndex: number;
  evicted: boolean;
  evictedRole?: AgentRole;
  evictedSessionName?: string;
}

/**
 * Manages a fixed set of agent slots.
 * Slot 0 is permanent (controller/orchestrator).
 * Slots 1-N are rotating — agents can be swapped in and out.
 */
export class SlotManager {
  private readonly slots: SlotState[];

  constructor(private readonly maxRotatingSlots: number = 3) {
    this.slots = Array.from({ length: maxRotatingSlots + 1 }, (_, i) => ({
      slotIndex: i,
      occupied: false,
      agentRole: null,
      provider: null,
      sessionName: null,
      startedAt: null,
    }));
  }

  getSlot(index: number): SlotState | undefined {
    if (index < 0 || index >= this.slots.length) return undefined;
    return this.slots[index];
  }

  getAllSlots(): readonly SlotState[] {
    return [...this.slots];
  }

  allocateSlot(role: AgentRole, provider: AgentProvider, preferredSlot?: number): EvictionResult {
    // If preferredSlot given, free, and valid (slot 0 only for system-designer)
    if (preferredSlot !== undefined) {
      const canUseSlot =
        preferredSlot > 0 || (preferredSlot === 0 && role === "system-designer");
      if (canUseSlot && this.isSlotFree(preferredSlot)) {
        this.occupySlot(preferredSlot, role, provider);
        return { slotIndex: preferredSlot, evicted: false };
      }
    }

    // Find first free rotating slot (1 to maxRotatingSlots)
    for (let i = 1; i <= this.maxRotatingSlots; i++) {
      if (this.isSlotFree(i)) {
        this.occupySlot(i, role, provider);
        return { slotIndex: i, evicted: false };
      }
    }

    // Evict the oldest rotating agent (slots 1-N only)
    let oldestIndex = -1;
    let oldestTime = Infinity;
    for (let i = 1; i <= this.maxRotatingSlots; i++) {
      const slot = this.slots[i];
      if (slot.occupied && slot.startedAt && slot.startedAt.getTime() < oldestTime) {
        oldestTime = slot.startedAt.getTime();
        oldestIndex = i;
      }
    }

    if (oldestIndex === -1) {
      throw new Error("No rotating slots available for eviction");
    }

    const evictedSlot = this.slots[oldestIndex];
    const evictedRole = evictedSlot.agentRole!;
    const evictedSessionName = evictedSlot.sessionName ?? undefined;

    this.resetSlot(oldestIndex);
    this.occupySlot(oldestIndex, role, provider);
    return { slotIndex: oldestIndex, evicted: true, evictedRole, evictedSessionName };
  }

  releaseSlot(index: number): void {
    if (index === 0) {
      throw new Error("Cannot release slot 0 (permanent controller slot)");
    }
    if (index < 0 || index >= this.slots.length) {
      throw new Error(`Slot index ${index} out of bounds`);
    }
    this.resetSlot(index);
  }

  isSlotFree(index: number): boolean {
    const slot = this.slots[index];
    if (!slot) return false;
    return !slot.occupied;
  }

  getOccupiedSlots(): SlotState[] {
    return this.slots.filter((s) => s.occupied);
  }

  findSlotByRole(role: AgentRole): SlotState | undefined {
    return this.slots.find((s) => s.occupied && s.agentRole === role);
  }

  private occupySlot(index: number, role: AgentRole, provider: AgentProvider): void {
    const slot = this.slots[index];
    slot.occupied = true;
    slot.agentRole = role;
    slot.provider = provider;
    slot.startedAt = new Date();
  }

  private resetSlot(index: number): void {
    const slot = this.slots[index];
    slot.occupied = false;
    slot.agentRole = null;
    slot.provider = null;
    slot.sessionName = null;
    slot.startedAt = null;
  }
}
