import { createServer, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

const SOCKET_PATH = "/tmp/cortexos.sock";

export interface IpcRequest {
  command: string;
  args: Record<string, unknown>;
}

export interface IpcResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type IpcHandler = (req: IpcRequest) => Promise<IpcResponse>;

export class IpcServer {
  private server: ReturnType<typeof createServer> | null = null;

  constructor(private handler: IpcHandler) {}

  start(): void {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

    this.server = createServer((socket: Socket) => {
      let buffer = "";

      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const req = JSON.parse(line) as IpcRequest;
            this.handler(req)
              .then((res) => {
                socket.write(JSON.stringify(res) + "\n");
              })
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                socket.write(JSON.stringify({ ok: false, error: message }) + "\n");
              });
          } catch {
            socket.write(
              JSON.stringify({ ok: false, error: "Invalid JSON in IPC request" }) + "\n",
            );
          }
        }
      });

      socket.on("error", () => {
        // Client disconnected unexpectedly — nothing to do
      });
    });

    this.server.listen(SOCKET_PATH, () => {
      console.log(`[IPC] Listening on ${SOCKET_PATH}`);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
    console.log("[IPC] Server stopped");
  }
}
