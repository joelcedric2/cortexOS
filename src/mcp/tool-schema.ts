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
];
