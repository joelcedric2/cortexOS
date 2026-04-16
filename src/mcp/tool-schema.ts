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

export const SOCIAL_SEND_SCHEMA: McpToolSchema = {
  name: "social_send",
  description:
    "Send a direct message on a social platform. Picks the right driver (IG/X/LinkedIn/etc.), runs the universal flow (login check → resolve target → open conversation → type message → escalation confirmation). Always triggers human confirmation before final send.",
  inputSchema: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        enum: [
          "ig", "x", "linkedin", "reddit", "tiktok",
          "discord", "telegram", "whatsapp", "imessage",
        ],
        description: "Target social platform.",
      },
      target: {
        type: "string",
        description:
          "Handle or display name of the recipient (e.g. '@jobed', '+15551234567').",
        minLength: 1,
        maxLength: 256,
      },
      message: {
        type: "string",
        description: "The message to send. Max 4000 chars.",
        minLength: 1,
        maxLength: 4000,
      },
    },
    required: ["platform", "target", "message"],
    additionalProperties: false,
  },
};

export const SOCIAL_POST_SCHEMA: McpToolSchema = {
  name: "social_post",
  description:
    "Publish content on a social platform. NOT YET IMPLEMENTED — ships in Phase 5. Always throws.",
  inputSchema: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        enum: [
          "ig", "x", "linkedin", "reddit", "tiktok",
          "discord", "telegram", "whatsapp", "imessage",
        ],
        description: "Target social platform.",
      },
      content: {
        type: "string",
        description: "The content to publish.",
        minLength: 1,
        maxLength: 10000,
      },
    },
    required: ["platform", "content"],
    additionalProperties: false,
  },
};

// ────────────────────────── Window-Manager Tools ──────────────────────────

export const WM_MOVE_WINDOW_SCHEMA: McpToolSchema = {
  name: "wm_move_window",
  description:
    "Relocate and/or resize a window. Any subset of {space, display, x, y, w, h} may be supplied; omitted fields leave that dimension unchanged. Returns {ok:false, error:'wm-unavailable'} if neither yabai nor AppleScript is usable.",
  inputSchema: {
    type: "object",
    properties: {
      windowId: { type: "integer", minimum: 1, description: "macOS window id." },
      space: { type: "integer", minimum: 1, description: "Target Mission Control space (1-indexed)." },
      display: { type: "integer", minimum: 1, description: "Target display (1-indexed)." },
      x: { type: "integer", description: "New top-left x in screen points." },
      y: { type: "integer", description: "New top-left y in screen points." },
      w: { type: "integer", minimum: 1, description: "New width in screen points." },
      h: { type: "integer", minimum: 1, description: "New height in screen points." },
    },
    required: ["windowId"],
    additionalProperties: false,
  },
};

export const WM_TILE_SCHEMA: McpToolSchema = {
  name: "wm_tile",
  description:
    "Apply a tiling layout to the current space: full, vsplit, hsplit, columns-3, columns-4, grid-2x2, or grid-3x2. Returns {ok:false, error:'wm-unavailable'} when the driver is missing.",
  inputSchema: {
    type: "object",
    properties: {
      layout: {
        type: "string",
        enum: ["full", "vsplit", "hsplit", "columns-3", "columns-4", "grid-2x2", "grid-3x2"],
        description: "Layout name.",
      },
    },
    required: ["layout"],
    additionalProperties: false,
  },
};

export const WM_FOCUS_SCHEMA: McpToolSchema = {
  name: "wm_focus",
  description:
    "Raise and activate a window by id. Returns {ok:false, error:'wm-unavailable'} if the driver is missing.",
  inputSchema: {
    type: "object",
    properties: {
      windowId: { type: "integer", minimum: 1, description: "macOS window id." },
    },
    required: ["windowId"],
    additionalProperties: false,
  },
};

export const WM_SPACE_SWITCH_SCHEMA: McpToolSchema = {
  name: "wm_space_switch",
  description:
    "Jump to the given Mission Control space (1-indexed). Returns {ok:false, error:'wm-unavailable'} if the driver is missing.",
  inputSchema: {
    type: "object",
    properties: {
      index: { type: "integer", minimum: 1, description: "Target space index (1-indexed)." },
    },
    required: ["index"],
    additionalProperties: false,
  },
};

export const WM_LIST_WINDOWS_SCHEMA: McpToolSchema = {
  name: "wm_list_windows",
  description:
    "Enumerate visible windows and spaces. Returns {ok:true, windows, spaces} or {ok:false, error:'wm-unavailable'}.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

// ────────────────────────── Perception Tools ──────────────────────────────

export const NCHINDA_SEE_SCHEMA: McpToolSchema = {
  name: "nchinda_see",
  description:
    "Capture one fresh screenshot via the macOS ScreenCaptureKit helper and return a compact VisionBrief (active_app, window_title, summary, visible_text, sentiment). Default `mode` is `local-only` (no network call). Pass `mode: \"llm\"` to opt in to a Claude Haiku vision polish step — falls back to local-only on any failure. Frames from private apps (1Password, Keychain, banking, …) are captured but never leave the device regardless of mode.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["local-only", "llm"],
        description:
          "local-only (default) = OCR + heuristic summary, zero network. llm = adds one Claude Haiku vision call with graceful fallback to local-only.",
      },
    },
    additionalProperties: false,
  },
};

export const NCHINDA_LOOK_SCHEMA: McpToolSchema = {
  name: "nchinda_look",
  description:
    "Capture ONE frame from the physical camera (front / back / continuity) and return a short description of what the camera sees, plus any OCR'd text. Optionally answer a user question about the frame using Claude Sonnet vision. Strictly one-shot — no loop. Falls back to a local-only reply when the LLM is unavailable.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "Optional user question about the frame (e.g. \"what am I looking at?\"). Max 2000 chars.",
        minLength: 1,
        maxLength: 2000,
      },
      device: {
        type: "string",
        enum: ["front", "back", "continuity"],
        description:
          "Physical camera to use. `continuity` is iPhone-as-webcam via Continuity Camera. Defaults to `front`.",
      },
    },
    additionalProperties: false,
  },
};

// ────────────────────────── Computer-use Tools (Phase 10) ────────────────

export const CU_CLICK_SCHEMA: McpToolSchema = {
  name: "cu_click",
  description:
    "Click the mouse at absolute screen (x, y). Bounds are 0..10000 on both axes. Default button is 'left'. Shells through the Swift `cortexos-vision input click` helper. Audit: one `cu_action` NDJSON line per call when an AuditLog is wired.",
  inputSchema: {
    type: "object",
    properties: {
      x: { type: "integer", minimum: 0, maximum: 10000, description: "Absolute screen x in points." },
      y: { type: "integer", minimum: 0, maximum: 10000, description: "Absolute screen y in points." },
      button: { type: "string", enum: ["left", "right"], description: "Mouse button (default left)." },
    },
    required: ["x", "y"],
    additionalProperties: false,
  },
};

export const CU_TYPE_SCHEMA: McpToolSchema = {
  name: "cu_type",
  description:
    "Synthesize keyboard input. Capped at 10000 characters per call to prevent runaway LLM output. Optional per-char delay 0..5000 ms. Does NOT check for irreversibility — wrap with agent-loop's policy gate when typing into send/compose fields.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 10000, description: "Unicode text to type." },
      delayMs: { type: "integer", minimum: 0, maximum: 5000, description: "Per-character delay in ms." },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

export const CU_SCREENSHOT_SCHEMA: McpToolSchema = {
  name: "cu_screenshot",
  description:
    "Take one fresh screenshot via the Swift `cortexos-vision input screenshot` helper. Returns `{path, width, height}`. The PNG is written to the default tmp path; callers may pair with `nchinda_see` for a structured brief.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const CU_FIND_ELEMENT_SCHEMA: McpToolSchema = {
  name: "cu_find_element",
  description:
    "AX query over running applications. Returns the first `{role, label, bbox, pid}` match or null. `role` is required (e.g. 'AXButton'); `label` and `app` (bundle id) narrow the walk.",
  inputSchema: {
    type: "object",
    properties: {
      role: { type: "string", minLength: 1, description: "AX role (e.g. 'AXButton')." },
      label: { type: "string", minLength: 1, description: "Case-insensitive label substring." },
      app: { type: "string", minLength: 1, description: "Bundle id to scope the search." },
    },
    required: ["role"],
    additionalProperties: false,
  },
};

export const CU_SCROLL_SCHEMA: McpToolSchema = {
  name: "cu_scroll",
  description:
    "Scroll at absolute (x, y) by `dy` pixels (negative = down). Optional `dx` for horizontal scroll. Moves the cursor first so the scroll lands on the intended element.",
  inputSchema: {
    type: "object",
    properties: {
      x: { type: "integer", minimum: 0, maximum: 10000 },
      y: { type: "integer", minimum: 0, maximum: 10000 },
      dy: { type: "integer", description: "Vertical scroll amount in pixels (negative = down)." },
      dx: { type: "integer", description: "Horizontal scroll amount in pixels (default 0)." },
    },
    required: ["x", "y", "dy"],
    additionalProperties: false,
  },
};

// ────────────────────────── Phase 12 Content-App Tools ─────────────────

export const SAFARI_OPEN_TAB_SCHEMA: McpToolSchema = {
  name: "safari_open_tab",
  description:
    "Open a URL in a new Safari tab (foreground). Activates Safari. Returns the new tab's id.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) or file:// URL.", minLength: 1 },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

export const SAFARI_READ_CURRENT_TAB_SCHEMA: McpToolSchema = {
  name: "safari_read_current_tab",
  description:
    "Read the front Safari tab's URL, title, and (when available) the document's innerText (Reader-like extraction via `do JavaScript`).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const SAFARI_LIST_TABS_SCHEMA: McpToolSchema = {
  name: "safari_list_tabs",
  description: "Enumerate every open Safari tab across windows.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const SAFARI_CLOSE_TAB_SCHEMA: McpToolSchema = {
  name: "safari_close_tab",
  description: "Close a Safari tab by id.",
  inputSchema: {
    type: "object",
    properties: { tabId: { type: "string", minLength: 1 } },
    required: ["tabId"],
    additionalProperties: false,
  },
};

export const SAFARI_LIST_BOOKMARKS_SCHEMA: McpToolSchema = {
  name: "safari_list_bookmarks",
  description: "List all Safari bookmarks across folders.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const SAFARI_SEARCH_HISTORY_SCHEMA: McpToolSchema = {
  name: "safari_search_history",
  description:
    "Full-text-ish search over Safari's local History.db. Matches URL or title; results ordered by most recent visit.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const NOTES_APPEND_SCHEMA: McpToolSchema = {
  name: "notes_append",
  description:
    "Append text to a Notes.app note by title. Creates the note if it doesn't exist in the given folder (defaults to the default folder).",
  inputSchema: {
    type: "object",
    properties: {
      noteTitle: { type: "string", minLength: 1 },
      text: { type: "string", minLength: 1 },
      folder: { type: "string" },
    },
    required: ["noteTitle", "text"],
    additionalProperties: false,
  },
};

export const NOTES_CREATE_SCHEMA: McpToolSchema = {
  name: "notes_create",
  description: "Create a new note with title + body in Notes.app.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1 },
      body: { type: "string" },
      folder: { type: "string" },
    },
    required: ["title", "body"],
    additionalProperties: false,
  },
};

export const NOTES_SEARCH_SCHEMA: McpToolSchema = {
  name: "notes_search",
  description: "Substring-match over Notes.app notes (title and plaintext).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const NOTES_DELETE_SCHEMA: McpToolSchema = {
  name: "notes_delete",
  description:
    "Delete a note by id. Always requires human confirmation — the handler raises an escalation first.",
  inputSchema: {
    type: "object",
    properties: { noteId: { type: "string", minLength: 1 } },
    required: ["noteId"],
    additionalProperties: false,
  },
};

export const REMINDERS_ADD_SCHEMA: McpToolSchema = {
  name: "reminders_add",
  description:
    "Add a reminder. Priority is 0 (none), 1 (high), 5 (medium), 9 (low) — same encoding as Reminders.app.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1 },
      dueAt: { type: "string", description: "ISO-8601 UTC date-time." },
      list: { type: "string" },
      notes: { type: "string" },
      priority: { type: "integer", enum: [0, 1, 5, 9] },
    },
    required: ["title"],
    additionalProperties: false,
  },
};

export const REMINDERS_COMPLETE_SCHEMA: McpToolSchema = {
  name: "reminders_complete",
  description: "Mark a reminder as completed.",
  inputSchema: {
    type: "object",
    properties: { reminderId: { type: "string", minLength: 1 } },
    required: ["reminderId"],
    additionalProperties: false,
  },
};

export const REMINDERS_LIST_SCHEMA: McpToolSchema = {
  name: "reminders_list",
  description: "List reminders, optionally filtered to a specific list.",
  inputSchema: {
    type: "object",
    properties: { listName: { type: "string" } },
    additionalProperties: false,
  },
};

export const REMINDERS_REMOVE_SCHEMA: McpToolSchema = {
  name: "reminders_remove",
  description:
    "Delete a reminder. Requires human confirmation — the handler raises an escalation first.",
  inputSchema: {
    type: "object",
    properties: { reminderId: { type: "string", minLength: 1 } },
    required: ["reminderId"],
    additionalProperties: false,
  },
};

export const MUSIC_PLAY_SCHEMA: McpToolSchema = {
  name: "music_play",
  description:
    "Play in Music.app. With `query`, searches tracks/artists and plays the first match; without, resumes playback.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    additionalProperties: false,
  },
};

export const MUSIC_PAUSE_SCHEMA: McpToolSchema = {
  name: "music_pause",
  description: "Pause playback in Music.app.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const MUSIC_SKIP_SCHEMA: McpToolSchema = {
  name: "music_skip",
  description: "Skip to the next track in Music.app.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const MUSIC_QUEUE_SCHEMA: McpToolSchema = {
  name: "music_queue",
  description:
    "Queue a matching track for later playback. Errors if no library track matches the name.",
  inputSchema: {
    type: "object",
    properties: { track: { type: "string", minLength: 1 } },
    required: ["track"],
    additionalProperties: false,
  },
};

export const MUSIC_SET_VOLUME_SCHEMA: McpToolSchema = {
  name: "music_set_volume",
  description: "Set Music.app's internal sound volume (0..100, rounded).",
  inputSchema: {
    type: "object",
    properties: { pct: { type: "number", minimum: 0, maximum: 100 } },
    required: ["pct"],
    additionalProperties: false,
  },
};

export const MUSIC_CURRENTLY_PLAYING_SCHEMA: McpToolSchema = {
  name: "music_currently_playing",
  description:
    "Return the currently playing track (title/artist/album) or null when stopped/paused.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const FINDER_REVEAL_SCHEMA: McpToolSchema = {
  name: "finder_reveal",
  description:
    "Open a Finder window selecting the given path. Read-only, no escalation.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", minLength: 1 } },
    required: ["path"],
    additionalProperties: false,
  },
};

export const FINDER_MOVE_SCHEMA: McpToolSchema = {
  name: "finder_move",
  description:
    "Move a file/folder via Finder. Requires human confirmation; path-traversal and symlink-escape checked.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", minLength: 1 },
      to: { type: "string", minLength: 1 },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
};

export const FINDER_RENAME_SCHEMA: McpToolSchema = {
  name: "finder_rename",
  description:
    "Rename a file/folder. Requires human confirmation; newName cannot contain / or NUL.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      newName: { type: "string", minLength: 1 },
    },
    required: ["path", "newName"],
    additionalProperties: false,
  },
};

export const FINDER_TAG_SCHEMA: McpToolSchema = {
  name: "finder_tag",
  description: "Set the Finder tags on a file/folder (replaces existing tags).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      tags: {
        type: "array",
        items: { type: "string", minLength: 1 },
        maxItems: 32,
      },
    },
    required: ["path", "tags"],
    additionalProperties: false,
  },
};

export const FINDER_LIST_TAGS_SCHEMA: McpToolSchema = {
  name: "finder_list_tags",
  description: "Read the Finder tags attached to a file/folder.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", minLength: 1 } },
    required: ["path"],
    additionalProperties: false,
  },
};

export const FINDER_TRASH_SCHEMA: McpToolSchema = {
  name: "finder_trash",
  description:
    "Move a file/folder to the Trash. Requires human confirmation; path-traversal + symlink-escape checked.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", minLength: 1 } },
    required: ["path"],
    additionalProperties: false,
  },
};

// ────────────────────────── Comms App Tools (Phase 12a) ──────────────────

export const MAIL_COMPOSE_SCHEMA: McpToolSchema = {
  name: "mail_compose",
  description:
    "Compose a new outgoing mail draft in Mail.app. Returns {draftId}. Does NOT send — use mail_send (which triggers an escalation) to actually transmit.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        description: "Single address string or array of addresses.",
        oneOf: [
          { type: "string", minLength: 1 },
          { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
        ],
      },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      body: { type: "string", minLength: 1, maxLength: 200000 },
      cc: { type: "array", items: { type: "string", minLength: 1 } },
      bcc: { type: "array", items: { type: "string", minLength: 1 } },
    },
    required: ["to", "subject", "body"],
    additionalProperties: false,
  },
};

export const MAIL_SEND_SCHEMA: McpToolSchema = {
  name: "mail_send",
  description:
    "Send a queued mail draft by id. IRREVERSIBLE — fires an escalation before transmitting.",
  inputSchema: {
    type: "object",
    properties: { draftId: { type: "string", minLength: 1 } },
    required: ["draftId"],
    additionalProperties: false,
  },
};

export const MAIL_REPLY_SCHEMA: McpToolSchema = {
  name: "mail_reply",
  description:
    "Create a reply draft to an existing message. Reversible — returns {draftId}; user must separately call mail_send to transmit.",
  inputSchema: {
    type: "object",
    properties: {
      messageId: { type: "string", minLength: 1 },
      body: { type: "string", minLength: 1, maxLength: 200000 },
    },
    required: ["messageId", "body"],
    additionalProperties: false,
  },
};

export const MAIL_SEARCH_SCHEMA: McpToolSchema = {
  name: "mail_search",
  description:
    "Search the Inbox by subject+content substring. Returns up to `limit` hits (default 20, max 200).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 1000 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const MAIL_UNREAD_COUNT_SCHEMA: McpToolSchema = {
  name: "mail_unread_count",
  description: "Return {count} of unread messages in the Inbox.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const MAIL_ARCHIVE_SCHEMA: McpToolSchema = {
  name: "mail_archive",
  description:
    "Move a message from the Inbox to the Archive mailbox. Reversible within Mail.app.",
  inputSchema: {
    type: "object",
    properties: { messageId: { type: "string", minLength: 1 } },
    required: ["messageId"],
    additionalProperties: false,
  },
};

export const MAIL_FLAG_SCHEMA: McpToolSchema = {
  name: "mail_flag",
  description: "Flag or unflag an Inbox message.",
  inputSchema: {
    type: "object",
    properties: {
      messageId: { type: "string", minLength: 1 },
      on: { type: "boolean" },
    },
    required: ["messageId", "on"],
    additionalProperties: false,
  },
};

export const MESSAGES_SEND_SCHEMA: McpToolSchema = {
  name: "messages_send",
  description:
    "Send an iMessage to a single handle (phone, email, Apple-ID). IRREVERSIBLE — fires an escalation before transmitting.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", minLength: 1, maxLength: 256 },
      body: { type: "string", minLength: 1, maxLength: 10000 },
      attachments: {
        type: "array",
        items: { type: "string", minLength: 1 },
        maxItems: 10,
      },
    },
    required: ["to", "body"],
    additionalProperties: false,
  },
};

export const MESSAGES_SEND_GROUP_SCHEMA: McpToolSchema = {
  name: "messages_send_group",
  description:
    "Send an iMessage to an existing group chat. IRREVERSIBLE — fires an escalation before transmitting.",
  inputSchema: {
    type: "object",
    properties: {
      chatId: { type: "string", minLength: 1, maxLength: 256 },
      body: { type: "string", minLength: 1, maxLength: 10000 },
    },
    required: ["chatId", "body"],
    additionalProperties: false,
  },
};

export const MESSAGES_REACT_SCHEMA: McpToolSchema = {
  name: "messages_react",
  description:
    "React to a message with a tapback emoji. Phase 12a audits the intent; full UI scripting lands in 12b.",
  inputSchema: {
    type: "object",
    properties: {
      messageId: { type: "string", minLength: 1 },
      emoji: { type: "string", minLength: 1, maxLength: 16 },
    },
    required: ["messageId", "emoji"],
    additionalProperties: false,
  },
};

export const MESSAGES_LIST_RECENT_SCHEMA: McpToolSchema = {
  name: "messages_list_recent",
  description: "List the `limit` most recent messages across chats (default 20).",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
    additionalProperties: false,
  },
};

export const MESSAGES_UNREAD_COUNT_SCHEMA: McpToolSchema = {
  name: "messages_unread_count",
  description: "Return {count} of chats with any unread message.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const CALENDAR_CREATE_SCHEMA: McpToolSchema = {
  name: "calendar_create",
  description:
    "Create a calendar event. IRREVERSIBLE (invites) — fires an escalation before creating when `attendees` is non-empty.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 512 },
      start: { type: "string", description: "ISO-8601 timestamp" },
      end: { type: "string", description: "ISO-8601 timestamp" },
      calendar: { type: "string", minLength: 1, maxLength: 128 },
      location: { type: "string", maxLength: 512 },
      notes: { type: "string", maxLength: 10000 },
      attendees: {
        type: "array",
        items: { type: "string", minLength: 1 },
        maxItems: 100,
      },
    },
    required: ["title", "start", "end"],
    additionalProperties: false,
  },
};

export const CALENDAR_FIND_GAP_SCHEMA: McpToolSchema = {
  name: "calendar_find_gap",
  description:
    "Find free gaps of at least `durationMin` minutes in [from, to]. Queries busy events from Calendar.app and computes gaps locally.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "ISO-8601 timestamp" },
      to: { type: "string", description: "ISO-8601 timestamp" },
      durationMin: { type: "integer", minimum: 1, maximum: 1440 },
    },
    required: ["from", "to", "durationMin"],
    additionalProperties: false,
  },
};

export const CALENDAR_DECLINE_SCHEMA: McpToolSchema = {
  name: "calendar_decline",
  description: "Mark an event as cancelled; optional reason is audited.",
  inputSchema: {
    type: "object",
    properties: {
      eventId: { type: "string", minLength: 1 },
      reason: { type: "string", maxLength: 1000 },
    },
    required: ["eventId"],
    additionalProperties: false,
  },
};

export const CALENDAR_LIST_UPCOMING_SCHEMA: McpToolSchema = {
  name: "calendar_list_upcoming",
  description:
    "List events starting within the next `withinMin` minutes (default 1440 = 24h, max 14 days).",
  inputSchema: {
    type: "object",
    properties: {
      withinMin: { type: "integer", minimum: 1, maximum: 20160 },
    },
    additionalProperties: false,
  },
};

/** Phase 12a comms-half schema bundle — appended to NCHINDA_TOOL_SCHEMAS below. */
export const PHASE12A_COMMS_SCHEMAS: McpToolSchema[] = [
  MAIL_COMPOSE_SCHEMA,
  MAIL_SEND_SCHEMA,
  MAIL_REPLY_SCHEMA,
  MAIL_SEARCH_SCHEMA,
  MAIL_UNREAD_COUNT_SCHEMA,
  MAIL_ARCHIVE_SCHEMA,
  MAIL_FLAG_SCHEMA,
  MESSAGES_SEND_SCHEMA,
  MESSAGES_SEND_GROUP_SCHEMA,
  MESSAGES_REACT_SCHEMA,
  MESSAGES_LIST_RECENT_SCHEMA,
  MESSAGES_UNREAD_COUNT_SCHEMA,
  CALENDAR_CREATE_SCHEMA,
  CALENDAR_FIND_GAP_SCHEMA,
  CALENDAR_DECLINE_SCHEMA,
  CALENDAR_LIST_UPCOMING_SCHEMA,
];

/** Phase 12 content-half schema bundle — appended to NCHINDA_TOOL_SCHEMAS below. */
export const PHASE12_CONTENT_SCHEMAS: McpToolSchema[] = [
  SAFARI_OPEN_TAB_SCHEMA,
  SAFARI_READ_CURRENT_TAB_SCHEMA,
  SAFARI_LIST_TABS_SCHEMA,
  SAFARI_CLOSE_TAB_SCHEMA,
  SAFARI_LIST_BOOKMARKS_SCHEMA,
  SAFARI_SEARCH_HISTORY_SCHEMA,
  NOTES_APPEND_SCHEMA,
  NOTES_CREATE_SCHEMA,
  NOTES_SEARCH_SCHEMA,
  NOTES_DELETE_SCHEMA,
  REMINDERS_ADD_SCHEMA,
  REMINDERS_COMPLETE_SCHEMA,
  REMINDERS_LIST_SCHEMA,
  REMINDERS_REMOVE_SCHEMA,
  MUSIC_PLAY_SCHEMA,
  MUSIC_PAUSE_SCHEMA,
  MUSIC_SKIP_SCHEMA,
  MUSIC_QUEUE_SCHEMA,
  MUSIC_SET_VOLUME_SCHEMA,
  MUSIC_CURRENTLY_PLAYING_SCHEMA,
  FINDER_REVEAL_SCHEMA,
  FINDER_MOVE_SCHEMA,
  FINDER_RENAME_SCHEMA,
  FINDER_TAG_SCHEMA,
  FINDER_LIST_TAGS_SCHEMA,
  FINDER_TRASH_SCHEMA,
];

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
  NCHINDA_SEE_SCHEMA,
  NCHINDA_LOOK_SCHEMA,
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
  SOCIAL_SEND_SCHEMA,
  SOCIAL_POST_SCHEMA,
  WM_MOVE_WINDOW_SCHEMA,
  WM_TILE_SCHEMA,
  WM_FOCUS_SCHEMA,
  WM_SPACE_SWITCH_SCHEMA,
  WM_LIST_WINDOWS_SCHEMA,
  CU_CLICK_SCHEMA,
  CU_TYPE_SCHEMA,
  CU_SCREENSHOT_SCHEMA,
  CU_FIND_ELEMENT_SCHEMA,
  CU_SCROLL_SCHEMA,
  ...PHASE12A_COMMS_SCHEMAS,
  ...PHASE12_CONTENT_SCHEMAS,
];
