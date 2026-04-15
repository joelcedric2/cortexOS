/**
 * Policy tests (Nchinda §2.2) — the escalation rules engine.
 *
 * Table-driven because the spec is itself table-shaped: each row asserts
 * one rule in isolation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { IrreversibleAction, Policy } from "../src/loop/policy.js";
import type { LoopBudget, SpentBudget } from "../src/loop/types.js";

const BUDGET_3: LoopBudget = { maxAttempts: 3 };

function spent(overrides: Partial<SpentBudget> = {}): SpentBudget {
  return { attempts: 0, ...overrides };
}

// ─── withinBudget ───────────────────────────────────────────────────────────

test("Policy.withinBudget returns true when nothing is spent", () => {
  const policy = new Policy();
  assert.equal(policy.withinBudget(spent(), BUDGET_3), true);
});

test("Policy.withinBudget returns false once attempts exceed the max", () => {
  const policy = new Policy();
  assert.equal(policy.withinBudget(spent({ attempts: 4 }), BUDGET_3), false);
});

test("Policy.withinBudget respects optional token ceiling", () => {
  const policy = new Policy();
  const budget: LoopBudget = { maxAttempts: 10, maxTokens: 1000 };
  assert.equal(policy.withinBudget(spent({ tokens: 999 }), budget), true);
  assert.equal(policy.withinBudget(spent({ tokens: 1001 }), budget), false);
});

test("Policy.withinBudget respects optional wall-clock ceiling", () => {
  const policy = new Policy();
  const budget: LoopBudget = { maxAttempts: 10, maxSeconds: 60 };
  assert.equal(policy.withinBudget(spent({ seconds: 59 }), budget), true);
  assert.equal(policy.withinBudget(spent({ seconds: 61 }), budget), false);
});

// ─── isIrreversible / irreversibleActionsIn ────────────────────────────────

const IRREVERSIBLE_CASES: Array<{ task: string; action: IrreversibleAction }> = [
  { task: "please rm -rf ./build", action: IrreversibleAction.RmRecursiveForce },
  { task: "run git push --force on main", action: IrreversibleAction.GitPushForce },
  { task: "execute git push -f origin main", action: IrreversibleAction.GitPushForce },
  { task: "do a git reset --hard HEAD~3", action: IrreversibleAction.GitResetHard },
  { task: "run DELETE FROM users WHERE 1=1", action: IrreversibleAction.DatabaseDelete },
  { task: "DROP TABLE orders", action: IrreversibleAction.DropTable },
  { task: "TRUNCATE orders", action: IrreversibleAction.TruncateTable },
  { task: "send a DM to @bob", action: IrreversibleAction.SocialDm },
  { task: "post a direct message", action: IrreversibleAction.SocialDm },
  { task: "send an email to the board", action: IrreversibleAction.EmailSend },
  { task: "charge $500 to the customer", action: IrreversibleAction.PaymentCharge },
  { task: "wire 1000 to vendor", action: IrreversibleAction.PaymentCharge },
  { task: "deploy to production now", action: IrreversibleAction.Deploy },
  { task: "publish to prod", action: IrreversibleAction.Deploy },
  { task: "save api_key = abc123 to file", action: IrreversibleAction.CredentialWrite },
  { task: "sudo rm /var/log", action: IrreversibleAction.SudoInstall },
];

for (const { task, action } of IRREVERSIBLE_CASES) {
  test(`Policy.isIrreversible detects ${action}: "${task}"`, () => {
    const policy = new Policy();
    assert.equal(policy.isIrreversible(task), true, `expected "${task}" to be irreversible`);
    assert.ok(
      policy.irreversibleActionsIn(task).includes(action),
      `expected detected actions to include ${action}`,
    );
  });
}

const SAFE_TASKS = [
  "please explain the orm architecture", // "rm" substring in "orm"
  "summarize the weather forecast",
  "list all the files in the repo",
  "write a unit test for the calculator",
  "", // empty string must not crash
];

for (const task of SAFE_TASKS) {
  test(`Policy.isIrreversible is false for safe task: "${task}"`, () => {
    const policy = new Policy();
    assert.equal(policy.isIrreversible(task), false);
    assert.deepEqual(policy.irreversibleActionsIn(task), []);
  });
}

test("Policy.irreversibleActionsIn reports every matching pattern", () => {
  const policy = new Policy();
  const hits = policy.irreversibleActionsIn(
    "rm -rf node_modules, then git push --force to main",
  );
  assert.ok(hits.includes(IrreversibleAction.RmRecursiveForce));
  assert.ok(hits.includes(IrreversibleAction.GitPushForce));
  assert.equal(hits.length, 2);
});

// ─── touchesCredentials ────────────────────────────────────────────────────

test("Policy.touchesCredentials flags .env files", () => {
  const policy = new Policy();
  assert.equal(policy.touchesCredentials("read .env to extract DATABASE_URL"), true);
});

test("Policy.touchesCredentials flags AWS secrets", () => {
  const policy = new Policy();
  assert.equal(policy.touchesCredentials("rotate the AWS_SECRET_KEY"), true);
});

test("Policy.touchesCredentials flags private keys", () => {
  const policy = new Policy();
  assert.equal(policy.touchesCredentials("load ~/.ssh/id_rsa for git"), true);
});

test("Policy.touchesCredentials returns false for innocent text", () => {
  const policy = new Policy();
  assert.equal(policy.touchesCredentials("count the number of envelopes"), false);
});

// ─── shouldEscalate ────────────────────────────────────────────────────────

test("Policy.shouldEscalate triggers on credential-touch before any other rule", () => {
  const policy = new Policy();
  const decision = policy.shouldEscalate({
    attempts: 1,
    lastErrorMessage: "",
    budget: BUDGET_3,
    spent: spent({ attempts: 1 }),
    task: "read .env secrets",
  });
  assert.equal(decision.escalate, true);
  assert.equal(decision.reason, "credential-touch");
});

test("Policy.shouldEscalate triggers budget-blown when attempts exceeded", () => {
  const policy = new Policy();
  const decision = policy.shouldEscalate({
    attempts: 4,
    lastErrorMessage: "network",
    budget: BUDGET_3,
    spent: spent({ attempts: 4 }),
    task: "fetch README",
  });
  assert.equal(decision.escalate, true);
  assert.equal(decision.reason, "budget-blown");
});

test("Policy.shouldEscalate triggers three-strike on 3 consecutive failures", () => {
  const policy = new Policy();
  const decision = policy.shouldEscalate({
    attempts: 3,
    lastErrorMessage: "500 server error",
    budget: { maxAttempts: 10 }, // plenty of budget
    spent: spent({ attempts: 3 }),
    task: "fetch README",
  });
  assert.equal(decision.escalate, true);
  assert.equal(decision.reason, "three-strike");
});

test("Policy.shouldEscalate honors explicit strikes counter when provided", () => {
  const policy = new Policy();
  const decision = policy.shouldEscalate({
    attempts: 10, // high total, but only 2 on this step
    lastErrorMessage: "x",
    budget: { maxAttempts: 20 },
    spent: spent({ attempts: 10 }),
    task: "fetch README",
    strikes: 2,
  });
  assert.equal(decision.escalate, false);
});

test("Policy.shouldEscalate returns false when all checks pass", () => {
  const policy = new Policy();
  const decision = policy.shouldEscalate({
    attempts: 2,
    lastErrorMessage: "timeout",
    budget: BUDGET_3,
    spent: spent({ attempts: 2 }),
    task: "fetch README",
  });
  assert.equal(decision.escalate, false);
  assert.equal(decision.reason, undefined);
});

test("Policy respects a custom strikeLimit", () => {
  const policy = new Policy({ strikeLimit: 5 });
  const decision = policy.shouldEscalate({
    attempts: 3,
    lastErrorMessage: "x",
    budget: { maxAttempts: 10 },
    spent: spent({ attempts: 3 }),
    task: "fetch README",
  });
  assert.equal(decision.escalate, false);
});
