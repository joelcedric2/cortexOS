import { connect } from "node:net";
import { existsSync } from "node:fs";

const SOCKET_PATH = "/tmp/cortexos.sock";

export function isControllerRunning(): boolean {
  return existsSync(SOCKET_PATH);
}

export async function ipcCall(
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (!isControllerRunning()) {
    throw new Error("CortexOS is not running. Start it with: cortex start");
  }

  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET_PATH);
    let buffer = "";

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("IPC call timed out after 30s"));
    }, 30_000);

    socket.on("connect", () => {
      socket.write(JSON.stringify({ command, args }) + "\n");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const res = JSON.parse(line) as { ok: boolean; data?: unknown; error?: string };
          clearTimeout(timeout);
          socket.end();
          if (res.ok) {
            resolve(res.data);
          } else {
            reject(new Error(res.error ?? "IPC call failed"));
          }
        } catch {
          // Incomplete JSON, wait for more data
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Cannot connect to CortexOS: ${err.message}`));
    });
  });
}
