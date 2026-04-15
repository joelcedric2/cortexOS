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

/** Canonical list used by the stdio server at registration time. */
export const NCHINDA_TOOL_SCHEMAS: McpToolSchema[] = [
  NCHINDA_RECALL_SCHEMA,
  NCHINDA_REMEMBER_SCHEMA,
  NCHINDA_RESEARCH_SCHEMA,
];
