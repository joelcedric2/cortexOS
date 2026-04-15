/**
 * Policy — Autonomy-Loop escalation rules engine (Nchinda §2.2).
 *
 * Pure functions where possible so the loop can reason about escalation
 * without side effects. Three responsibilities:
 *   1. `shouldEscalate` — decide whether the loop must hand off to a human
 *      after an observed failure (3-strike, budget, credentials).
 *   2. `isIrreversible` — detect patterns we will NEVER execute without
 *      explicit confirmation (rm -rf, git push --force, deploys, DMs, …).
 *   3. `withinBudget` — cheap predicate for attempt/token/second budgets.
 */
import type { EscalationDecision, LoopBudget, SpentBudget } from "./types.js";

/**
 * Typed enumeration of patterns that require human confirmation (§2.2).
 * These are regex-backed, not substring sniffing, so we can express word
 * boundaries and avoid false positives like "harm_less" matching "rm ".
 */
export enum IrreversibleAction {
  RmRecursiveForce = "rm_recursive_force",
  GitPushForce = "git_push_force",
  GitResetHard = "git_reset_hard",
  DatabaseDelete = "database_delete",
  DropTable = "drop_table",
  TruncateTable = "truncate_table",
  SocialDm = "social_dm",
  EmailSend = "email_send",
  PaymentCharge = "payment_charge",
  Deploy = "deploy",
  CredentialWrite = "credential_write",
  SudoInstall = "sudo_install",
}

interface IrreversiblePattern {
  readonly action: IrreversibleAction;
  readonly pattern: RegExp;
}

/**
 * Patterns are anchored with word boundaries where possible, and use
 * case-insensitive matching. Order matters only for tie-breaking in
 * `irreversibleActionsIn` — `isIrreversible` itself short-circuits.
 */
const IRREVERSIBLE_PATTERNS: readonly IrreversiblePattern[] = Object.freeze([
  { action: IrreversibleAction.RmRecursiveForce, pattern: /\brm\b\s+(?:-[a-z]*[rf][a-z]*\s+)+\S+/i },
  { action: IrreversibleAction.GitPushForce, pattern: /\bgit\s+push\b[^\n]*(?:--force|-f\b|--force-with-lease)/i },
  { action: IrreversibleAction.GitResetHard, pattern: /\bgit\s+reset\b[^\n]*--hard\b/i },
  { action: IrreversibleAction.DatabaseDelete, pattern: /\bDELETE\s+FROM\b/i },
  { action: IrreversibleAction.DropTable, pattern: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i },
  { action: IrreversibleAction.TruncateTable, pattern: /\bTRUNCATE\s+(?:TABLE\s+)?\w+/i },
  { action: IrreversibleAction.SocialDm, pattern: /\b(?:send|post)\s+(?:a\s+)?(?:dm|direct\s+message)\b/i },
  { action: IrreversibleAction.EmailSend, pattern: /\bsend\s+(?:an?\s+)?email\b/i },
  { action: IrreversibleAction.PaymentCharge, pattern: /\b(?:charge|pay|transfer|wire)\b[^\n]*\$?\d+/i },
  { action: IrreversibleAction.Deploy, pattern: /\b(?:deploy|publish|release)\b[^\n]*(?:prod|production|live)/i },
  // Standalone package publishing (no "prod" qualifier needed — always irreversible)
  { action: IrreversibleAction.Deploy, pattern: /\bnpm\s+publish\b/i },
  { action: IrreversibleAction.Deploy, pattern: /\b(?:pip|cargo|gem|yarn)\s+publish\b/i },
  // Informal "ship to prod" / "push to prod" phrasing
  { action: IrreversibleAction.Deploy, pattern: /\b(?:ship|push)\b[^\n]*\bto\b[^\n]*(?:prod|production|live)\b/i },
  // Hyphenated force-push forms (common in chat/shorthand)
  { action: IrreversibleAction.GitPushForce, pattern: /\bforce[- ]push\b/i },
  { action: IrreversibleAction.CredentialWrite, pattern: /\b(?:api[_\s-]?key|secret|token|password|credential)s?\b[^\n]*(?:=|:|\bto\b)/i },
  { action: IrreversibleAction.SudoInstall, pattern: /\bsudo\s+(?:rm|dd|mkfs|reboot|shutdown|chown|chmod)\b/i },
]);

/**
 * Anything matching these is treated as a credential-touch: even reads go
 * through confirmation. Separate list so `shouldEscalate` can distinguish
 * "touched creds" from "generic irreversible action" in its reason code.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  // `.env`, `.env.production`, etc. Leading non-word char (or SOL), then the literal dot.
  /(?:^|[^A-Za-z0-9])\.env(?:\.\w+)?\b/i,
  // AWS_SECRET_KEY, GCP-TOKEN, AZURE SECRET, etc.
  /\b(?:AWS|GCP|AZURE)[_\s-](?:SECRET|KEY|TOKEN|ACCESS)(?:[_\s-]\w+)*\b/i,
  /\b(?:private[_\s-]?key|id_rsa|ssh[_\s-]?key)\b/i,
  /\bkeychain\b/i,
  /\bsecrets?\b/i,
]);

export interface EscalationContext {
  attempts: number;
  lastErrorMessage: string;
  budget: LoopBudget;
  spent: SpentBudget;
  task: string;
  /** How many consecutive strikes we've seen on this step. Defaults to `attempts`. */
  strikes?: number;
}

export interface PolicyOptions {
  /** Default 3 per §2.2 ("3 failed attempts on the same step"). */
  strikeLimit?: number;
}

export class Policy {
  private readonly strikeLimit: number;

  constructor(opts: PolicyOptions = {}) {
    this.strikeLimit = opts.strikeLimit ?? 3;
  }

  /**
   * Decide escalation from an observed failure. The loop calls this after
   * each failed attempt, before walking the Resourcefulness ladder.
   */
  shouldEscalate(ctx: EscalationContext): EscalationDecision {
    if (this.touchesCredentials(ctx.task)) {
      return {
        escalate: true,
        reason: "credential-touch",
        detail: `task mentions credentials — requires confirmation`,
      };
    }

    if (!this.withinBudget(ctx.spent, ctx.budget)) {
      return {
        escalate: true,
        reason: "budget-blown",
        detail: this.budgetDetail(ctx.spent, ctx.budget),
      };
    }

    const strikes = ctx.strikes ?? ctx.attempts;
    if (strikes >= this.strikeLimit) {
      return {
        escalate: true,
        reason: "three-strike",
        detail: `${strikes} consecutive failures on this step (limit ${this.strikeLimit})`,
      };
    }

    return { escalate: false };
  }

  /** Fast predicate: is the task string asking for something we'll never do silently? */
  isIrreversible(task: string): boolean {
    if (typeof task !== "string" || task.length === 0) return false;
    return IRREVERSIBLE_PATTERNS.some((p) => p.pattern.test(task));
  }

  /**
   * Enumerate every irreversible action detected in `task`. Useful for
   * building a detailed confirmation prompt ("this will rm AND git push
   * --force; proceed?"). Returns [] when nothing matches.
   */
  irreversibleActionsIn(task: string): IrreversibleAction[] {
    if (typeof task !== "string" || task.length === 0) return [];
    const hits: IrreversibleAction[] = [];
    for (const p of IRREVERSIBLE_PATTERNS) {
      if (p.pattern.test(task)) hits.push(p.action);
    }
    return hits;
  }

  /** Pure budget check — exposed on the class for easy injection/stubbing. */
  withinBudget(spent: SpentBudget, budget: LoopBudget): boolean {
    if (spent.attempts > budget.maxAttempts) return false;
    if (budget.maxTokens !== undefined && (spent.tokens ?? 0) > budget.maxTokens) {
      return false;
    }
    if (budget.maxSeconds !== undefined && (spent.seconds ?? 0) > budget.maxSeconds) {
      return false;
    }
    return true;
  }

  /** Returns true if the task even mentions credentials (read OR write). */
  touchesCredentials(task: string): boolean {
    if (typeof task !== "string" || task.length === 0) return false;
    return CREDENTIAL_PATTERNS.some((p) => p.test(task));
  }

  private budgetDetail(spent: SpentBudget, budget: LoopBudget): string {
    const parts: string[] = [`attempts ${spent.attempts}/${budget.maxAttempts}`];
    if (budget.maxTokens !== undefined) {
      parts.push(`tokens ${spent.tokens ?? 0}/${budget.maxTokens}`);
    }
    if (budget.maxSeconds !== undefined) {
      parts.push(`seconds ${spent.seconds ?? 0}/${budget.maxSeconds}`);
    }
    return parts.join("; ");
  }
}
