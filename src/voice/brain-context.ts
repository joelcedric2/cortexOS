/**
 * Brain CLAUDE.md Generator
 *
 * Builds the CLAUDE.md that gets injected into the persistent brain
 * session's working directory. This is how the brain session learns
 * about Nchinda's personality, available tools, memory, and voice
 * mode rules.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NCHINDA_TOOL_SCHEMAS } from "../mcp/tool-schema.js";
import type { VectorStore, MemorySearchResult } from "../memory/vector-store.js";
import type { Embedder } from "../memory/embedder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

export interface BrainContextDeps {
  soulPath?: string;
  vectorStore?: VectorStore;
  embedder?: Embedder;
  userName?: string;
}

/* ------------------------------------------------------------------ */
/*  Section builders                                                   */
/* ------------------------------------------------------------------ */

async function buildSoulSection(soulPath: string): Promise<string> {
  try {
    const soul = await readFile(soulPath, "utf-8");
    return soul.trim();
  } catch {
    return "<!-- SOUL.md not found — personality section skipped -->";
  }
}

function buildVoiceModeSection(): string {
  return `## Voice Mode

Your replies are spoken aloud via text-to-speech. Follow these rules:
- Be conversational and concise. 1-4 sentences for simple questions, more for complex tasks.
- NO markdown formatting, NO code blocks, NO bullet points, NO headers.
- Just natural speech — as if you're talking to Cedric face to face.
- If you need to share code or structured data, say "I'll put the details in the terminal" and keep your spoken reply brief.`;
}

function buildToolUsageSection(): string {
  return `## Tool Usage

You have full access to bash, file system, web search, and all cortexOS MCP tools.
Use your tools to find real answers. Never guess when you can look it up or run a command.
If you don't know something, figure it out — you have the tools to do so.`;
}

function buildToolListSection(): string {
  const lines = NCHINDA_TOOL_SCHEMAS.map(
    (t) => `- ${t.name}: ${t.description.split(".")[0]}.`,
  );
  return `## Available cortexOS Tools\n\n${lines.join("\n")}`;
}

async function buildMemorySection(
  vectorStore: VectorStore | undefined,
  embedder: Embedder | undefined,
): Promise<string> {
  if (!vectorStore || !embedder) {
    return "<!-- Memory section skipped — no vectorStore/embedder provided -->";
  }

  try {
    const embedding = await embedder.embed("voice interaction context");
    const memories: MemorySearchResult[] = await vectorStore.searchMemories(
      embedding,
      5,
    );

    if (memories.length === 0) {
      return "## Recent Context from Memory\n\nNo recent memories found.";
    }

    const lines = memories.map(
      (m, i) => `${i + 1}. [${m.outcome}] ${m.content}`,
    );
    return `## Recent Context from Memory\n\n${lines.join("\n")}`;
  } catch {
    return "<!-- Memory recall failed — section skipped -->";
  }
}

function buildUserProfileSection(userName: string): string {
  return `## About the User

- Name: Cedric Joel Yantio II (address as "${userName}" or "Sir")
- Prefers action over discussion
- Values speed, quality, and autonomy
- Says "go ahead" or "continue" to mean full autonomy`;
}

/* ------------------------------------------------------------------ */
/*  Main export                                                        */
/* ------------------------------------------------------------------ */

export async function buildBrainClaudeMd(
  deps: BrainContextDeps,
): Promise<string> {
  const soulPath = deps.soulPath ?? join(REPO_ROOT, "SOUL.md");
  const userName = deps.userName ?? "Cedric";

  const [soul, memory] = await Promise.all([
    buildSoulSection(soulPath),
    buildMemorySection(deps.vectorStore, deps.embedder),
  ]);

  const sections = [
    soul,
    buildVoiceModeSection(),
    buildToolUsageSection(),
    buildToolListSection(),
    memory,
    buildUserProfileSection(userName),
  ];

  return sections.join("\n\n");
}
