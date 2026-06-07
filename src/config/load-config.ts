/**
 * Load ~/.cortexos/config.json at boot and inject keys into process.env.
 *
 * This is the OpenClaw pattern: keys live in the agent's own filesystem,
 * not in shell profiles. cortexOS reads them at startup — no env vars
 * needed, no restarts, no source ~/.zshrc.
 *
 * The file is also writable by Nchinda itself — `cortex config set`
 * or an agent can modify it, and the next boot picks it up.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".cortexos", "config.json");

interface CortexConfig {
  keys?: Record<string, string>;
  voice?: Record<string, string | number>;
  defaults?: Record<string, string>;
  deepgram_api_key?: string;
}

export function loadCortexConfig(): CortexConfig | null {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as CortexConfig;

    // Inject all keys into process.env (only if not already set —
    // explicit env vars override the config file)
    if (config.keys) {
      for (const [key, value] of Object.entries(config.keys)) {
        if (value && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }

    // Inject Deepgram key (top-level shorthand, same as keys.DEEPGRAM_API_KEY)
    if (config.deepgram_api_key && !process.env.DEEPGRAM_API_KEY) {
      process.env.DEEPGRAM_API_KEY = config.deepgram_api_key;
    }

    // Inject defaults the same way
    if (config.defaults) {
      for (const [key, value] of Object.entries(config.defaults)) {
        const envKey = `CORTEXOS_${key.toUpperCase()}`;
        if (value && !process.env[envKey]) {
          process.env[envKey] = value;
        }
      }
    }

    console.log(`[config] Loaded ${CONFIG_PATH}`);
    return config;
  } catch {
    // No config file — that's fine, use env vars as fallback
    return null;
  }
}
