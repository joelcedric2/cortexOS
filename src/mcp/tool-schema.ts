/**
 * JSON-schema declarations for Nchinda's MCP tools.
 *
 * Consumed by scripts/mcp/serve-nchinda.mjs when it advertises tools over
 * the MCP `tools/list` RPC. Kept as plain JS objects (not zod) because the
 * MCP protocol wants JSON Schema draft-07-ish shapes directly.
 *
 * The runtime handlers (src/mcp/nchinda-tools.ts) still validate inputs
 * with zod — this file only controls what Claude sees in tool discovery.
 */

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export const NCHINDA_RECALL_SCHEMA: McpToolSchema = {
  name: "nchinda_recall",
  description:
    "Top-k semantic search over Nchinda's long-term memory. Returns hydrated memory rows ranked by cosine similarity. Use this before attempting a task to surface patterns from similar past work.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language description of what you're looking for.",
        minLength: 1,
      },
      k: {
        type: "integer",
        description: "How many hits to return. Default 5.",
        minimum: 1,
        maximum: 50,
      },
      filter: {
        type: "object",
        description:
          "Optional DB-level narrowing. Leave off for a cross-role search.",
        properties: {
          agent_role: {
            type: "string",
            description:
              "Restrict to memories authored by this agent role (e.g. 'coder').",
          },
          task_type: {
            type: "string",
            description:
              "Restrict to memories of this task type (e.g. 'implementation').",
          },
        },
        additionalProperties: false,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const NCHINDA_REMEMBER_SCHEMA: McpToolSchema = {
  name: "nchinda_remember",
  description:
    "Explicitly write a learning into Nchinda's long-term memory. Called during the Report phase of the Autonomy Loop — on success, on failure, or after recovery via the fallback chain.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The learning itself, written as a crisp one-liner you'd want your future self to read.",
        minLength: 1,
      },
      outcome: {
        type: "string",
        enum: ["success", "fail", "recovered"],
        description:
          "success = task completed on first attempt; fail = abandoned; recovered = completed via fallback chain.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Free-form tags for retrieval (e.g. ['auth', 'jwt']).",
        default: [],
      },
      agent_role: {
        type: "string",
        description:
          "Optional override for the authoring agent's role. Defaults to the caller's registered role.",
      },
      task_type: {
        type: "string",
        description:
          "Optional task type (e.g. 'implementation', 'debug'). Defaults to 'general'.",
      },
    },
    required: ["content", "outcome"],
    additionalProperties: false,
  },
};


export const NCHINDA_SCHEDULE_SCHEMA: McpToolSchema = {
  name: "nchinda_schedule",
  description:
    "Create a cron job from a natural-language schedule phrase. Parses the utterance (e.g. \"every Friday at 5pm\") into a 5-field cron expression, inserts a disabled job into the scheduler, and optionally enables it. Use this when the user asks Nchinda to recurringly do something on a schedule.",
  inputSchema: {
    type: "object",
    properties: {
      utterance: {
        type: "string",
        description:
          "The full natural-language schedule + task (e.g. \"every Friday at 5pm: email me the weekly summary\").",
        minLength: 1,
      },
      autoEnable: {
        type: "boolean",
        description:
          "When true, flip the new job to enabled=true immediately. Default false (user opt-in later).",
        default: false,
      },
      createdBy: {
        type: "string",
        enum: ["user", "nchinda_proactive"],
        description:
          "Who is scheduling. \"user\" when the user asked; \"nchinda_proactive\" when Nchinda is scheduling itself.",
        default: "user",
      },
      timezone: {
        type: "string",
        description:
          "Optional IANA timezone override.",
      },
    },
    required: ["utterance"],
    additionalProperties: false,
  },
};

export const NCHINDA_RESEARCH_SCHEMA: McpToolSchema = {
  name: "nchinda_research",
  description:
    "Inline H→P→R→B research loop (plan §2.3). Generates 3-5 hypotheses, probes each in parallel, updates beliefs, and returns a consolidated Brief with a winning hypothesis + confidence. Use this for quick investigations that don't warrant a full researcher pane.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question the loop should investigate.",
        minLength: 1,
      },
      depth: {
        type: "string",
        enum: ["normal", "deep"],
        description:
          "normal = 3 hypotheses × 1 probe × 2min budget; deep = 5 × 2 × 5min. Defaults to normal.",
      },
      timeBudgetMs: {
        type: "integer",
        description:
          "Override the overall wall-clock budget in milliseconds. Clamped 1s..10min.",
        minimum: 1000,
        maximum: 600000,
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
};

export const NCHINDA_SEND_SCHEMA: McpToolSchema = {
  name: "nchinda_send",
  description:
    "Send a text message from Nchinda (or another slot) to a single agent slot. Thin wrapper over MessageBus.send; targets must be occupied or the call throws.",
  inputSchema: {
    type: "object",
    properties: {
      to_slot: { type: "integer", minimum: 0, description: "Destination slot index (must be occupied)." },
      body: { type: "string", minLength: 1, maxLength: 10000, description: "Message body, 1..10000 chars." },
      from_slot: { type: "integer", minimum: 0, description: "Sender slot. Defaults to -1 (system/nchinda)." },
    },
    required: ["to_slot", "body"],
    additionalProperties: false,
  },
};

export const NCHINDA_BROADCAST_SCHEMA: McpToolSchema = {
  name: "nchinda_broadcast",
  description:
    "Broadcast a message to every occupied slot except the sender. Useful for status nudges or coordinated halts.",
  inputSchema: {
    type: "object",
    properties: {
      body: { type: "string", minLength: 1, maxLength: 10000, description: "Message body, 1..10000 chars." },
      from_slot: { type: "integer", minimum: 0, description: "Sender slot. Defaults to -1 (system/nchinda)." },
    },
    required: ["body"],
    additionalProperties: false,
  },
};

export const NCHINDA_STATUS_SCHEMA: McpToolSchema = {
  name: "nchinda_status",
  description:
    "Registry snapshot: list of agents with id/role/status/task_id/tmux_session/uptime_s plus active_count and standby_count. Read-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const NCHINDA_ESCALATE_SCHEMA: McpToolSchema = {
  name: "nchinda_escalate",
  description:
    "Raise a user-facing question. Persists a row in the escalations table AND emits an error-kind event on the bus so live observers learn about it. No voice surfacing in Phase 3.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1, maxLength: 4000, description: "The question to raise." },
      level: {
        type: "string",
        enum: ["info", "question", "blocker", "ask"],
        description: "Severity. 'ask' is an LLM-ergonomic alias for 'question' and is the default.",
      },
      task_id: { type: "string", description: "Associated task id, if any." },
      agent_id: { type: "string", description: "Agent id that raised this, if any." },
    },
    required: ["question"],
    additionalProperties: false,
  },
};

export const NCHINDA_ASK_PEER_SCHEMA: McpToolSchema = {
  name: "nchinda_ask_peer",
  description:
    "Ask a peer agent (by role) a question and await their reply. Returns {ok:true,answer} on success or {ok:false,reason:'no-peer'|'timeout'}. Default timeout 30s.",
  inputSchema: {
    type: "object",
    properties: {
      role: { type: "string", minLength: 1, maxLength: 64, description: "Target peer role." },
      question: { type: "string", minLength: 1, maxLength: 4000, description: "The question to ask." },
      timeout_s: { type: "integer", minimum: 1, maximum: 600, description: "Wait budget in seconds (default 30)." },
    },
    required: ["role", "question"],
    additionalProperties: false,
  },
};

export const WEB_SEARCH_SCHEMA: McpToolSchema = {
  name: "web_search",
  description:
    "Generic web search. Uses Tavily when TAVILY_API_KEY is set, falls back to a dev-only DuckDuckGo HTML scraper. Returns up to 10 results, each with title/url/snippet (snippet truncated to 500 chars). Never throws — on any failure (network, timeout, schema) resolves to [] with a redacted warning.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The natural-language search query.",
        minLength: 1,
      },
      limit: {
        type: "integer",
        description: "Max results to return. Clamped to 10.",
        minimum: 1,
        maximum: 10,
      },
      timeoutMs: {
        type: "integer",
        description: "Per-request timeout in ms. Default 8000.",
        minimum: 500,
        maximum: 60000,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const TOOL_DISCOVERY_SCHEMA: McpToolSchema = {
  name: "tool_discovery",
  description:
    "Meta-tool. Given a natural-language need, asks Claude Haiku to pick the top 3 tools from our catalog. Returns {name, confidence (0..1), rationale}. Use this when you're unsure which tool to call. Never throws — returns [] on any LLM/network failure.",
  inputSchema: {
    type: "object",
    properties: {
      need: {
        type: "string",
        description: "Natural-language description of what you want to do.",
        minLength: 1,
      },
      timeoutMs: {
        type: "integer",
        description: "Per-call timeout in ms. Default 8000.",
        minimum: 500,
        maximum: 60000,
      },
    },
    required: ["need"],
    additionalProperties: false,
  },
};

export const SKILL_DISCOVER_SCHEMA: McpToolSchema = {
  name: "skill_discover",
  description:
    "Semantic skill search. Given a natural-language need, returns ranked candidate skills from the registry with slug, description, and confidence.",
  inputSchema: {
    type: "object",
    properties: {
      need: {
        type: "string",
        description: "Natural-language description of what you need a skill to do.",
        minLength: 1,
      },
    },
    required: ["need"],
    additionalProperties: false,
  },
};

export const SKILL_INSTALL_SCHEMA: McpToolSchema = {
  name: "skill_install",
  description:
    "Install a skill from a GitHub repository. Clones the repo, vets for safety, auto-generates SKILL.md from README if missing, and registers as 'unvetted'. Only accepts https://github.com/ URLs.",
  inputSchema: {
    type: "object",
    properties: {
      repo_url: {
        type: "string",
        description: "HTTPS GitHub repository URL (must start with https://github.com/).",
        minLength: 1,
      },
      subpath: {
        type: "string",
        description: "Optional subdirectory within the repo that contains the skill.",
      },
    },
    required: ["repo_url"],
    additionalProperties: false,
  },
};

export const SKILL_USE_SCHEMA: McpToolSchema = {
  name: "skill_use",
  description:
    "Execute a registered skill by slug. Runs in a sandbox on macOS (deny-default profile). Respects trust levels — quarantined and deprecated skills are rejected. Max timeout 300s.",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description: "The skill's slug identifier.",
        minLength: 1,
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Command-line arguments to pass to the skill entrypoint.",
        default: [],
      },
      env: {
        type: "object",
        description: "Optional environment variables to set for the skill process.",
        additionalProperties: { type: "string" },
      },
      timeout_s: {
        type: "integer",
        description: "Execution timeout in seconds (1..300). Default 30.",
        minimum: 1,
        maximum: 300,
      },
    },
    required: ["slug"],
    additionalProperties: false,
  },
};

export const SKILL_CREATE_SCHEMA: McpToolSchema = {
  name: "skill_create",
  description:
    "Create a new skill from a natural-language description. Runs a 7-step flow: research → design SKILL.md → scaffold tests → implement → vet → register → validate. Returns the created skill's id, path, and test results.",
  inputSchema: {
    type: "object",
    properties: {
      need: {
        type: "string",
        description: "Natural-language description of the capability to create.",
        minLength: 1,
      },
      name: {
        type: "string",
        description: "Optional slug for the skill. Auto-derived from need if omitted.",
      },
      language: {
        type: "string",
        enum: ["typescript", "python", "shell"],
        description: "Implementation language. Default: typescript.",
      },
    },
    required: ["need"],
    additionalProperties: false,
  },
};

// ────────────────────────── CDP Browser Tools ──────────────────────────

export const CDP_NAVIGATE_SCHEMA: McpToolSchema = {
  name: "cdp_navigate",
  description:
    "Navigate the browser to a URL and wait for the page to load. Opens a CDP-controlled Chrome tab if none exists.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to navigate to (must be a valid URL).",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

export const CDP_CLICK_SCHEMA: McpToolSchema = {
  name: "cdp_click",
  description:
    "Click an element on the page by CSS selector. Resolves the selector, computes the center of the element's bounding box, and dispatches mouse press/release events.",
  inputSchema: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for the element to click.",
      },
    },
    required: ["selector"],
    additionalProperties: false,
  },
};

export const CDP_TYPE_SCHEMA: McpToolSchema = {
  name: "cdp_type",
  description:
    "Type text into an input element. First clicks the element to focus it, then dispatches key events for each character.",
  inputSchema: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for the input element.",
      },
      text: {
        type: "string",
        description: "The text to type.",
      },
      delay: {
        type: "integer",
        description: "Delay in ms between keystrokes (0-1000). Default 0.",
        minimum: 0,
        maximum: 1000,
      },
    },
    required: ["selector", "text"],
    additionalProperties: false,
  },
};

export const CDP_READ_TEXT_SCHEMA: McpToolSchema = {
  name: "cdp_read_text",
  description:
    "Extract visible text from the page. When selector is omitted, returns document.body.innerText.",
  inputSchema: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "Optional CSS selector. Defaults to document.body.",
      },
    },
    additionalProperties: false,
  },
};

export const CDP_SCREENSHOT_SCHEMA: McpToolSchema = {
  name: "cdp_screenshot",
  description:
    "Capture a PNG screenshot of the current page. Returns base64-encoded image data.",
  inputSchema: {
    type: "object",
    properties: {
      fullPage: {
        type: "boolean",
        description: "Capture the full scrollable page, not just the viewport. Default false.",
      },
    },
    additionalProperties: false,
  },
};

export const CDP_WAIT_FOR_SCHEMA: McpToolSchema = {
  name: "cdp_wait_for",
  description:
    "Wait until a CSS selector matches an element on the page. Polls via requestAnimationFrame. Throws on timeout.",
  inputSchema: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector to wait for.",
      },
      timeoutMs: {
        type: "integer",
        description: "Max wait time in ms (100-30000). Default 5000.",
        minimum: 100,
        maximum: 30000,
      },
    },
    required: ["selector"],
    additionalProperties: false,
  },
};

/** Canonical list used by the stdio server at registration time. */
export const NCHINDA_TOOL_SCHEMAS: McpToolSchema[] = [
  NCHINDA_RECALL_SCHEMA,
  NCHINDA_REMEMBER_SCHEMA,
  NCHINDA_SCHEDULE_SCHEMA,
  NCHINDA_RESEARCH_SCHEMA,
  NCHINDA_SEND_SCHEMA,
  NCHINDA_BROADCAST_SCHEMA,
  NCHINDA_STATUS_SCHEMA,
  NCHINDA_ESCALATE_SCHEMA,
  NCHINDA_ASK_PEER_SCHEMA,
  WEB_SEARCH_SCHEMA,
  TOOL_DISCOVERY_SCHEMA,
  SKILL_DISCOVER_SCHEMA,
  SKILL_INSTALL_SCHEMA,
  SKILL_USE_SCHEMA,
  SKILL_CREATE_SCHEMA,
  CDP_NAVIGATE_SCHEMA,
  CDP_CLICK_SCHEMA,
  CDP_TYPE_SCHEMA,
  CDP_READ_TEXT_SCHEMA,
  CDP_SCREENSHOT_SCHEMA,
  CDP_WAIT_FOR_SCHEMA,
];
