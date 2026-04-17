/**
 * Groq STT — whisper-large-v3-turbo via Groq's free API.
 *
 * Replaces local whisper-cli. Faster (~0.3s vs ~2s), more accurate
 * (large-v3 vs small.en), zero RAM usage, free tier = 28,800 audio
 * seconds/day (~8 hours of continuous listening).
 *
 * API key from GROQ_API_KEY env var — never hardcoded.
 */

import { readFileSync } from "node:fs";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
/** turbo for wake-word speed; full for command accuracy */
export const GROQ_MODEL_FAST = "whisper-large-v3-turbo";
export const GROQ_MODEL_ACCURATE = "whisper-large-v3";

export interface GroqTranscription {
  text: string;
  duration?: number;
}

export async function transcribeWithGroq(
  wavPath: string,
  opts?: { apiKey?: string; language?: string; timeoutMs?: number; model?: string },
): Promise<GroqTranscription> {
  const apiKey = opts?.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY not set — cannot transcribe");
  }

  const audioData = readFileSync(wavPath);
  const model = opts?.model ?? GROQ_MODEL_FAST;
  const boundary = `----boundary${Date.now()}`;

  // Build multipart form data manually (no deps)
  const parts: Buffer[] = [];

  // file field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
  ));
  parts.push(audioData);
  parts.push(Buffer.from("\r\n"));

  // model field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`,
  ));

  // language field
  const lang = opts?.language ?? "en";
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${lang}\r\n`,
  ));

  // response_format
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`,
  ));

  // closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 10_000);

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Groq API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as { text?: string; duration?: number };
    return {
      text: (json.text ?? "").trim(),
      duration: json.duration,
    };
  } finally {
    clearTimeout(timer);
  }
}
