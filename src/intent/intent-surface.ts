/**
 * Intent router (plan §4 Phase 14).
 *
 * Turns a `ConvIntent` into a side-effect on cortexOS, strictly obeying the
 * current proactivity mode. The **cardinal rule** (§2.2 of the plan) is that
 * `stated-intent` **never** auto-executes — the assistant only offers or
 * pre-drafts, and the user must confirm.
 *
 * Behaviour matrix:
 *
 *   silent         → no-op
 *   volunteer      → push an observation onto the PendingSurface, urgency 0.4,
 *                    label "Offer to execute: <verb> <object>"
 *   anticipatory   → same surface + call the tool's drafter (opens Mail
 *                    compose window, queues the conversation state, etc.) via
 *                    an injected `drafter` callback. Never sends.
 *   autonomous     → same as anticipatory PLUS a higher-urgency surface
 *                    (0.55) tagged "Confirm send — tap Y".
 *
 * `direct-command` / `question` / `idle-chat` / `reminder` are **not** routed
 * here — the orchestrator handles those paths (direct-command via onTask,
 * reminders via the reminders tool, etc.). This module only reacts to
 * `stated-intent`; other kinds are a silent no-op so it's safe to pipe every
 * intent through.
 */
import type { ProactivityMode } from "../proactivity/modes.js";
import type { SkillRegistryDB } from "../skills/skill-registry-db.js";
import type { AuditLog } from "../proactivity/audit.js";
import type { ConvIntent, ActionCandidate } from "./conversation-intent.js";

/**
 * Pre-drafts an action — e.g. opens Mail's compose window, queues an iMessage
 * conversation state, stages a calendar event. Must be REVERSIBLE and must
 * NEVER send / commit / dispatch the action.
 *
 * The return value is recorded on the surface item so a future "confirm"
 * handler can pick it back up.
 */
export type ActionDrafter = (
  action: ActionCandidate,
  ctx: { intent: ConvIntent },
) => Promise<DraftHandle | null>;

/** Opaque handle to a draft the drafter produced. */
export interface DraftHandle {
  /** Stable id for the draft (e.g. `mail:draft-42`). */
  id: string;
  /** Tool the draft lives in ("mail_compose", "social_send", …). */
  tool: string;
  /** Human-readable note for the audit log / UI. */
  note?: string;
}

/**
 * Store-writer contract — minimal surface of `ObservationStore` we use to
 * insert a row the `PendingSurface.list()` can pick up.
 */
export interface ObservationWriter {
  insert(sample: {
    sensorName: string;
    observation: string;
    urgency: number;
    data?: Record<string, unknown>;
    sampledAt: Date;
  }): number;
}

export interface IntentSurfaceDeps {
  /** Writer for new observations (typically the ObservationStore). */
  store: ObservationWriter;
  /** Skill registry — used to validate a suggested_tool exists. */
  registry?: Pick<SkillRegistryDB, "list" | "get">;
  /** Current proactivity mode (polled per call, not cached). */
  proactivityMode: () => ProactivityMode;
  /** Optional drafter — required for anticipatory / autonomous. */
  drafter?: ActionDrafter;
  /** Optional audit log. */
  audit?: AuditLog;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

/** Sensor name used for every row this module inserts. */
export const INTENT_SENSOR_NAME = "conversation-intent";

/** Outcome summary — exported mainly for tests and observability. */
export interface SurfaceOutcome {
  surfaced: boolean;
  draftId?: string;
  urgency?: number;
  reason: string;
}

/**
 * Route a `ConvIntent` through the proactivity policy. Only `stated-intent`
 * produces side-effects; everything else is a no-op (returns
 * `{ surfaced: false, reason: "not-stated-intent" }`).
 *
 * Never throws — drafter / registry / audit failures are caught and folded
 * into the returned reason.
 */
export async function surfaceIntent(
  intent: ConvIntent,
  deps: IntentSurfaceDeps,
): Promise<SurfaceOutcome> {
  if (intent.kind !== "stated-intent") {
    return { surfaced: false, reason: "not-stated-intent" };
  }

  const mode = deps.proactivityMode();
  const now = (deps.now ?? (() => new Date()))();

  if (mode === "silent") {
    safeAudit(deps.audit, {
      action: "voice_intent",
      detail: `conv-intent skipped mode=silent kind=${intent.kind}`,
      ts: now,
    });
    return { surfaced: false, reason: "silent-mode" };
  }

  const action = intent.action_candidate;
  if (!action) {
    // No extractable action — surface as a low-urgency note-to-self only.
    return surfaceObservation(deps, {
      mode,
      intent,
      action: undefined,
      urgency: 0.3,
      draft: null,
      now,
    });
  }

  // Validate the suggested tool exists in the registry, if any.
  const toolOk =
    action.suggested_tool === undefined ||
    deps.registry === undefined ||
    isToolInstalled(deps.registry, action.suggested_tool);

  if (!toolOk) {
    // Tool not installed — still surface, just without a drafter call.
    return surfaceObservation(deps, {
      mode,
      intent,
      action,
      urgency: 0.4,
      draft: null,
      now,
      note: `suggested_tool ${action.suggested_tool} not installed`,
    });
  }

  // Anticipatory / autonomous → pre-draft the action first (never sends).
  let draft: DraftHandle | null = null;
  let draftError: string | undefined;
  if ((mode === "anticipatory" || mode === "autonomous") && deps.drafter) {
    try {
      draft = await deps.drafter(action, { intent });
    } catch (err) {
      draftError = err instanceof Error ? err.message : String(err);
    }
  }

  // Urgency ladder.
  //   volunteer      → 0.40 ("consider this")
  //   anticipatory   → 0.45 ("pre-drafted, consider")
  //   autonomous     → 0.55 ("tap Y to confirm")
  const urgency =
    mode === "autonomous" ? 0.55 : mode === "anticipatory" ? 0.45 : 0.4;

  return surfaceObservation(deps, {
    mode,
    intent,
    action,
    urgency,
    draft,
    draftError,
    now,
  });
}

// ─── Internals ──────────────────────────────────────────────────────────────

interface InsertCtx {
  mode: ProactivityMode;
  intent: ConvIntent;
  action: ActionCandidate | undefined;
  urgency: number;
  draft: DraftHandle | null;
  draftError?: string;
  now: Date;
  note?: string;
}

function surfaceObservation(
  deps: IntentSurfaceDeps,
  ctx: InsertCtx,
): SurfaceOutcome {
  const label = buildLabel(ctx);
  const data: Record<string, unknown> = {
    kind: ctx.intent.kind,
    source: ctx.intent.source,
    mode: ctx.mode,
    transcript: ctx.intent.transcript,
  };
  if (ctx.action) data.action_candidate = ctx.action;
  if (ctx.draft) data.draft = ctx.draft;
  if (ctx.draftError) data.draft_error = redactDraftError(ctx.draftError);
  if (ctx.note) data.note = ctx.note;
  // Hint the UI which action is most natural.
  data.confirm_action =
    ctx.mode === "autonomous" ? "tap Y to confirm send" : "Offer to execute";

  let insertErr: string | undefined;
  try {
    deps.store.insert({
      sensorName: INTENT_SENSOR_NAME,
      observation: label,
      urgency: ctx.urgency,
      data,
      sampledAt: ctx.now,
    });
  } catch (err) {
    insertErr = err instanceof Error ? err.message : String(err);
  }

  // Audit — always record the routing decision, even on insert failure so
  // we don't silently drop intent audits.
  safeAudit(deps.audit, {
    action: "voice_intent",
    detail: buildAuditDetail(ctx, insertErr),
    ts: ctx.now,
  });

  if (insertErr) {
    return { surfaced: false, reason: `insert-failed` };
  }

  return {
    surfaced: true,
    draftId: ctx.draft?.id,
    urgency: ctx.urgency,
    reason: `mode=${ctx.mode}`,
  };
}

function buildLabel(ctx: InsertCtx): string {
  if (!ctx.action) {
    return "Note to self";
  }
  const { verb, object, recipients } = ctx.action;
  const who = recipients && recipients.length > 0
    ? ` (${recipients.join(", ")})`
    : "";
  const prefix = ctx.mode === "autonomous" ? "Confirm send" : "Offer to execute";
  return `${prefix}: ${verb} ${object}${who}`.trim();
}

function buildAuditDetail(ctx: InsertCtx, insertErr: string | undefined): string {
  const parts: string[] = [
    `conv-intent mode=${ctx.mode}`,
    `kind=${ctx.intent.kind}`,
    `urgency=${ctx.urgency.toFixed(2)}`,
  ];
  if (ctx.action) {
    parts.push(`verb=${ctx.action.verb}`);
    if (ctx.action.suggested_tool) parts.push(`tool=${ctx.action.suggested_tool}`);
  }
  if (ctx.draft) parts.push(`draft=${ctx.draft.tool}:${ctx.draft.id}`);
  if (ctx.draftError) parts.push(`draft_error=${redactDraftError(ctx.draftError)}`);
  if (ctx.note) parts.push(`note=${ctx.note}`);
  if (insertErr) parts.push(`insert_error=1`);
  return parts.join(" ");
}

/** Drafters may throw arbitrary messages; redact to a small set of labels. */
function redactDraftError(msg: string): string {
  if (/timeout|abort/i.test(msg)) return "timeout";
  if (/permission|unauthorized/i.test(msg)) return "permission-denied";
  if (/not\s*found|no\s*such/i.test(msg)) return "tool-not-found";
  if (/network|fetch|econn/i.test(msg)) return "network";
  return "unknown";
}

function isToolInstalled(
  registry: Pick<SkillRegistryDB, "list" | "get">,
  toolId: string,
): boolean {
  // Skills are addressable by id OR by name. Try id first, then fall back to
  // a name scan.
  try {
    if (registry.get(toolId)) return true;
    const rows = registry.list({ limit: 500 });
    return rows.some((r) => r.name === toolId || r.id === toolId);
  } catch {
    // Registry read failure should not block the surface.
    return true;
  }
}

function safeAudit(
  audit: AuditLog | undefined,
  entry: { action: "voice_intent"; detail: string; ts: Date },
): void {
  if (!audit) return;
  try {
    audit.append(entry);
  } catch {
    // Audit failures are non-fatal.
  }
}
