/**
 * AutonomyLoop factory — wires the production-default dependency graph.
 *
 * Callers who don't want to hand-roll an AutonomyLoop (policy, classifier,
 * strategies, attempts log) can call `createAutonomyLoop(...)` with a small
 * dependency triple and get a production-shaped loop back.
 *
 * Intent classifier wiring: we use `createClassifier({ mode: 'auto' })` from
 * `src/classifier/index.ts` so the loop gets Haiku when `ANTHROPIC_API_KEY`
 * is set and the deterministic heuristic classifier otherwise — matching
 * the plan §2 "classifier-first" routing.
 */
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { AgentRegistry } from "../registry/agent-registry.js";
import type { EventBus } from "../ipc/event-bus.js";
import type { Classifier } from "../classifier/classifier.js";
import { createClassifier } from "../classifier/index.js";
import { AutonomyLoop } from "./autonomy-loop.js";
import type { AutonomyLoopDeps } from "./autonomy-loop.js";
import { Policy } from "./policy.js";
import { LoopAttemptLog } from "./loop-attempts-db.js";
import { defaultStrategies } from "./fallback-strategies.js";
import type { FallbackStrategy, LoopBudget } from "./types.js";

export interface CreateAutonomyLoopOptions {
  /** Core wiring — required. */
  orchestrator: Orchestrator;
  registry: AgentRegistry;
  bus: EventBus;

  /** Optional overrides; defaults match the plan §2 production shape. */
  classifier?: Classifier;
  policy?: Policy;
  attemptsLog?: LoopAttemptLog;
  strategies?: FallbackStrategy[];
  budget?: LoopBudget;

  /**
   * Path to the SQLite registry DB used by `LoopAttemptLog`. Defaults to the
   * shared `~/.cortexos/registry.db` file per DECISIONS §D2. Pass an in-memory
   * path (`:memory:`) from tests.
   */
  attemptsDbPath?: string;

  /**
   * Explicit classifier mode override. When `classifier` is also supplied
   * this is ignored. Defaults to `"auto"` — Haiku if ANTHROPIC_API_KEY is
   * present, else the heuristic classifier.
   */
  classifierMode?: "auto" | "haiku" | "heuristic";
}

/**
 * Build an AutonomyLoop with production defaults. The only required inputs
 * are the orchestrator, registry, and shared event bus — everything else has
 * a sensible default that matches the §2/§5.1 plan.
 */
export function createAutonomyLoop(opts: CreateAutonomyLoopOptions): AutonomyLoop {
  const classifier =
    opts.classifier ?? createClassifier({ mode: opts.classifierMode ?? "auto" });

  const policy = opts.policy ?? new Policy();
  const strategies = opts.strategies ?? defaultStrategies();
  const attemptsLog =
    opts.attemptsLog ??
    (opts.attemptsDbPath
      ? new LoopAttemptLog({ dbPath: opts.attemptsDbPath })
      : undefined);

  const deps: AutonomyLoopDeps = {
    orchestrator: opts.orchestrator,
    registry: opts.registry,
    bus: opts.bus,
    policy,
    classifier,
    attemptsLog,
    strategies,
    budget: opts.budget,
  };

  return new AutonomyLoop(deps);
}
