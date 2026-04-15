/**
 * Probe executors — pluggable backends that run a single probe string and
 * return its observed result.
 *
 * The research loop (§2.3 step 3) designs probes as natural-language text
 * ("grep recent auth logs for 401s", "web-search 'axios retry interceptor'",
 * etc.). An executor decides whether it can run a given probe (`canRun`) and,
 * if so, returns a textual result that gets fed to UPDATE_BELIEFS.
 *
 * Phase 2.5 ships three executors:
 *   - `echoExecutor` — baseline; returns the probe text. Lets the loop
 *      exercise end-to-end without real tool calls and gives deterministic
 *      fixtures for tests.
 *   - `webSearchStub` — TODO Phase 3; matches web-search shaped probes and
 *      returns a marker so the loop can route them later.
 *   - `shellStub` — TODO Phase 3; matches shell-shaped probes.
 *
 * Real implementations land in Phase 3 when we wire the CDP browser and the
 * sandboxed shell. The `ProbeExecutor` interface is intentionally minimal so
 * Phase 3 can drop in replacements without touching the loop.
 */

export interface ProbeExecutor {
  /** Human-readable id for telemetry + ordering. */
  readonly name: string;
  /** Does this executor know how to run `probe`? Fast, synchronous. */
  canRun(probe: string): boolean;
  /** Run the probe and return its observed result as plain text. */
  run(probe: string): Promise<string>;
}

/**
 * Dispatches a probe to the first executor whose `canRun` returns true.
 * Executors are tried in the order passed. If none match, falls back to the
 * `echoExecutor` so the loop never deadlocks on an unroutable probe.
 */
export async function runProbe(
  probe: string,
  executors: ReadonlyArray<ProbeExecutor>,
): Promise<{ executor: string; result: string }> {
  for (const ex of executors) {
    if (ex.canRun(probe)) {
      const result = await ex.run(probe);
      return { executor: ex.name, result };
    }
  }
  const result = await echoExecutor.run(probe);
  return { executor: echoExecutor.name, result };
}

// --------------------------- echo -----------------------------------------

/**
 * Baseline executor. Matches every probe. Returns the probe text itself as
 * the "result". This is deliberate: it lets the loop run end-to-end with no
 * external side effects, and tests can feed it to UPDATE_BELIEFS to verify
 * the Bayesian update math without having to mock a network.
 */
export const echoExecutor: ProbeExecutor = {
  name: "echo",
  canRun: () => true,
  async run(probe: string): Promise<string> {
    return `echo: ${probe}`;
  },
};

// --------------------------- web-search stub (Phase 3) --------------------

const WEB_SEARCH_PATTERNS: ReadonlyArray<RegExp> = [
  /^web[_-]?search\b/i,
  /\bgoogle\b/i,
  /\bsearch\s+(the\s+)?web\b/i,
  /\bbing\b/i,
];

/**
 * TODO(phase-3): replace with a real search-engine adapter (Tavily, Brave,
 * or the CDP-driven Google fallback). For now, flags that a probe looks
 * web-search shaped and returns a deterministic stub so the loop can cite
 * it without blocking on network.
 */
export const webSearchStub: ProbeExecutor = {
  name: "web-search-stub",
  canRun(probe: string): boolean {
    return WEB_SEARCH_PATTERNS.some((re) => re.test(probe));
  },
  async run(probe: string): Promise<string> {
    return `[TODO-phase-3 web_search] would search: ${probe}`;
  },
};

// --------------------------- shell stub (Phase 3) -------------------------

const SHELL_PATTERNS: ReadonlyArray<RegExp> = [
  /^shell\b/i,
  /^bash\b/i,
  /^\$\s/,
  /\brun\s+`[^`]+`/,
  /\bgrep\b/i,
  /\bls\b/,
];

/**
 * TODO(phase-3): replace with a sandboxed `child_process.exec` adapter
 * (jailed cwd, tight env, no network). For now, flags shell-shaped probes
 * and returns a stub.
 */
export const shellStub: ProbeExecutor = {
  name: "shell-stub",
  canRun(probe: string): boolean {
    return SHELL_PATTERNS.some((re) => re.test(probe));
  },
  async run(probe: string): Promise<string> {
    return `[TODO-phase-3 shell] would run: ${probe}`;
  },
};

// --------------------------- defaults -------------------------------------

/**
 * Default executor chain for Phase 2.5 — shell + web-search stubs first (so
 * probes get routed to a marker a Phase 3 drop-in will recognise), echo
 * last as the catch-all.
 */
export const DEFAULT_EXECUTORS: ReadonlyArray<ProbeExecutor> = [
  shellStub,
  webSearchStub,
  echoExecutor,
];
