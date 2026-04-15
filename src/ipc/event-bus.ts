/**
 * In-process event bus for agent lifecycle events.
 *
 * Owned by Agent A (Phase 1 — hooks + IPC). Agent B (orchestrator/registry)
 * consumes this contract. The shape is intentionally frozen — do not change
 * without coordinating with the orchestrator.
 */
import { EventEmitter } from "node:events";

export type EventKind =
  | "done"
  | "heartbeat"
  | "compact"
  | "error"
  | "plan_emitted"
  // Appended by Agent A (Phase 2 — Autonomy Loop). Agent B may append more
  // kinds at the end; do not re-order.
  | "loop_state"
  // Appended by Agent A (Phase 2.5 — Research Agent). Emitted once per
  // completed H→P→R→B loop with the Brief as payload.
  | "research_brief_emitted";

export interface AgentEvent {
  kind: EventKind;
  slot?: number;
  session_id?: string;
  agent_id?: string;
  task_id?: string;
  payload?: unknown;
  ts: Date;
}

export type EventFilter = Partial<
  Pick<AgentEvent, "kind" | "slot" | "session_id" | "agent_id" | "task_id">
>;

export interface EventBus {
  emit(event: AgentEvent): void;
  subscribe(filter: EventFilter, handler: (e: AgentEvent) => void): () => void;
  once(filter: EventFilter, timeoutMs?: number): Promise<AgentEvent>;
}

const CHANNEL = "agent-event";

function matches(event: AgentEvent, filter: EventFilter): boolean {
  if (filter.kind !== undefined && event.kind !== filter.kind) return false;
  if (filter.slot !== undefined && event.slot !== filter.slot) return false;
  if (filter.session_id !== undefined && event.session_id !== filter.session_id) {
    return false;
  }
  if (filter.agent_id !== undefined && event.agent_id !== filter.agent_id) {
    return false;
  }
  if (filter.task_id !== undefined && event.task_id !== filter.task_id) {
    return false;
  }
  return true;
}

class InProcessEventBus implements EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many subscribers may attach in a long-running process.
    this.emitter.setMaxListeners(0);
  }

  emit(event: AgentEvent): void {
    this.emitter.emit(CHANNEL, event);
  }

  subscribe(filter: EventFilter, handler: (e: AgentEvent) => void): () => void {
    const listener = (event: AgentEvent) => {
      if (matches(event, filter)) handler(event);
    };
    this.emitter.on(CHANNEL, listener);
    return () => {
      this.emitter.off(CHANNEL, listener);
    };
  }

  once(filter: EventFilter, timeoutMs?: number): Promise<AgentEvent> {
    return new Promise<AgentEvent>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let unsubscribe: () => void = () => {};

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        unsubscribe();
      };

      unsubscribe = this.subscribe(filter, (event) => {
        cleanup();
        resolve(event);
      });

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`EventBus.once timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }
}

export function createEventBus(): EventBus {
  return new InProcessEventBus();
}
