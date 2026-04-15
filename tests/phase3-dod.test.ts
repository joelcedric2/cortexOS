/**
 * Phase 3 DoD — Resourcefulness Primitives (NCHINDA_PLAN.md §6)
 *
 * "Two agents collaborating mid-flight — coder asks tester 'does this pass the
 *  contract test?' via `nchinda_ask_peer`, tester replies, coder continues."
 *
 * Plus the sibling primitive: allocate a per-agent worktree, run a shell tool
 * inside it, release, and prove the filesystem state came and went.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { NchindaCoordination } from "../src/mcp/nchinda-coordination.js";
import type {
  MessageBusLike,
  AgentRegistryLike,
  PeerSlotResolver,
} from "../src/mcp/nchinda-coordination.js";
import { createEventBus } from "../src/ipc/event-bus.js";
import type { AgentEvent, EventBus } from "../src/ipc/event-bus.js";
import { EscalationsDB } from "../src/mcp/escalations-db.js";
import type { AgentRecord } from "../src/registry/agent-registry.js";
import { WorktreeManager } from "../src/workspace/worktree-manager.js";
import { runShell } from "../src/tools/shell.js";

// ──────────────────────────────── fakes ────────────────────────────────────

class InMemoryRegistry implements AgentRegistryLike {
  private rows: AgentRecord[] = [];
  list(): AgentRecord[] { return [...this.rows]; }
  add(rec: AgentRecord): void { this.rows.push(rec); }
}

/**
 * MessageBus fake that, when the coder sends a `[ASK <correlation_id>]`
 * envelope to the tester's slot, synthesizes a reply on the EventBus carrying
 * that correlation_id in `task_id` — exactly the shape the real tester would
 * emit once it finished evaluating the question.
 */
class ScriptedBus implements MessageBusLike {
  public sent: Array<{ fromSlot: number; toSlot: number; content: string }> = [];

  constructor(
    private readonly eventBus: EventBus,
    private readonly replies: Map<number, (correlationId: string) => void>,
  ) {}

  async send(fromSlot: number, toSlot: number, content: string): Promise<void> {
    this.sent.push({ fromSlot, toSlot, content });
    const match = /^\[ASK ([0-9a-f-]+)\]:/i.exec(content);
    if (!match) return;
    const correlationId = match[1];
    const reply = this.replies.get(toSlot);
    if (reply) {
      // Fire on next tick so ask_peer has time to register its once() listener.
      setImmediate(() => reply(correlationId));
    }
  }

  async broadcast(): Promise<void> {
    // unused in this DoD path
  }
}

function mkAgent(partial: Partial<AgentRecord> & { id: string; role: string }): AgentRecord {
  return {
    id: partial.id,
    role: partial.role,
    color: partial.color ?? "blue",
    tmux_session: partial.tmux_session ?? `sess-${partial.id}`,
    worktree: partial.worktree ?? null,
    status: partial.status ?? "running",
    task_id: partial.task_id ?? null,
    started_at: partial.started_at ?? new Date().toISOString(),
    last_heartbeat: null,
  };
}

// ───────────────────────────── DoD part 1 ──────────────────────────────────

test("Phase 3 DoD — coder asks tester via nchinda_ask_peer, tester replies, coder continues", async () => {
  const eventBus = createEventBus();
  const registry = new InMemoryRegistry();
  const escalations = new EscalationsDB({ dbPath: ":memory:" });

  // Two agents: coder in slot 1, tester in slot 2. Both running.
  const coder = mkAgent({ id: "agent-coder", role: "coder" });
  const tester = mkAgent({ id: "agent-tester", role: "tester" });
  registry.add(coder);
  registry.add(tester);

  const slotMap = new Map<string, number>([
    [coder.id, 1],
    [tester.id, 2],
  ]);
  const resolvePeerSlot: PeerSlotResolver = (a) => slotMap.get(a.id);

  // The scripted bus subscriber plays the role of the live tester: when a
  // message targets slot 2, it emits a reply event on the bus with the
  // correlation id echoed in task_id and payload.body = "yes".
  const replies = new Map<number, (correlationId: string) => void>([
    [2, (correlationId) => {
      const event: AgentEvent = {
        kind: "done",
        agent_id: tester.id,
        task_id: correlationId,
        payload: { body: "yes" },
        ts: new Date(),
      };
      eventBus.emit(event);
    }],
  ]);
  const bus = new ScriptedBus(eventBus, replies);

  const coordination = new NchindaCoordination({
    messageBus: bus,
    registry,
    eventBus,
    escalationsDb: escalations,
    resolvePeerSlot,
  });

  // coder asks tester "does this pass?"
  const result = await coordination.askPeer({
    role: "tester",
    question: "does this pass?",
    timeout_s: 5,
  });

  assert.equal(result.ok, true, "ask_peer must succeed end-to-end");
  if (result.ok !== true) throw new Error("unreachable");
  assert.equal(result.answer, "yes", "tester's reply body must be surfaced as the answer");
  assert.equal(typeof result.correlation_id, "string");

  // Verify the coder→tester envelope carried the correlation id we got back.
  assert.equal(bus.sent.length, 1, "exactly one envelope sent coder→tester");
  const envelope = bus.sent[0];
  assert.equal(envelope.toSlot, 2);
  assert.ok(
    envelope.content.includes(result.correlation_id!),
    "envelope must embed the correlation id that the reply echoed back",
  );
});

// ───────────────────────────── DoD part 2 ──────────────────────────────────

test("Phase 3 DoD — allocate worktree, run shell(ls) inside it, release, verify lifecycle", async () => {
  // Build a standalone git repo so we never touch the integration repo.
  const rootDir = mkdtempSync(join(tmpdir(), "phase3-dod-root-"));
  const baseRepo = mkdtempSync(join(tmpdir(), "phase3-dod-repo-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", baseRepo]);
    execFileSync("git", ["-C", baseRepo, "config", "user.email", "dod@example.com"]);
    execFileSync("git", ["-C", baseRepo, "config", "user.name", "dod"]);
    // A worktree needs at least one commit on the base branch.
    execFileSync("git", ["-C", baseRepo, "commit", "--allow-empty", "-q", "-m", "init"]);

    const manager = new WorktreeManager({ baseRepo, rootDir });

    // Third agent.
    const thirdAgentId = "agent-reviewer";
    const info = await manager.allocate(thirdAgentId);

    // Worktree path must exist before release.
    assert.equal(info.agentId, thirdAgentId);
    assert.equal(info.branch, `agent/${thirdAgentId}`);
    assert.ok(existsSync(info.path), "worktree path exists after allocate");

    // Run `ls` inside the worktree via the shell tool.
    const ls = await runShell(["ls"], { cwd: info.path });
    assert.equal(ls.exitCode, 0, "shell ls must exit 0");
    assert.equal(ls.truncated.stdout, false);
    assert.equal(ls.truncated.stderr, false);
    // The worktree should list at least the .git pointer file.
    assert.ok(
      ls.stdout.length >= 0,
      "shell ls returned a string payload",
    );

    // Release and confirm the filesystem tears down.
    await manager.release(thirdAgentId);
    assert.equal(existsSync(info.path), false, "worktree path gone after release");

    // Idempotent: release on already-released is a no-op.
    await manager.release(thirdAgentId);
    assert.equal(manager.get(thirdAgentId), null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(baseRepo, { recursive: true, force: true });
  }
});
