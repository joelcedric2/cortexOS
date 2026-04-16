/**
 * WebSocket server bridging the AudioStateMachine to Mission Control's
 * Nchinda waveform visualiser. Broadcasts NchindaWaveState frames at
 * a configurable rate (default 30 Hz) to all connected clients on
 * ws://localhost:3100/audio.
 *
 * See docs/NCHINDA_PLAN.md §7.5 for the state contract.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { createServer, type Server as HttpServer } from "node:http";
import type { AudioStateMachine, AudioStateEvent } from "./audio-state.js";

/** Shape sent to each connected client every tick. */
export interface NchindaWaveState {
  state: string;
  rms: number;
  caption?: string;
  lastEventAt: string; // ISO-8601
}

export interface WSBridgeOptions {
  /** TCP port for the WebSocket server. Default 3100. */
  port?: number;
  /** The audio state machine to observe. */
  stateMachine: AudioStateMachine;
  /** Broadcast rate in Hz. Default 30. */
  publishRateHz?: number;
}

export class VoiceWSBridge {
  private readonly port: number;
  private readonly sm: AudioStateMachine;
  private readonly intervalMs: number;
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastEvent: AudioStateEvent | null = null;

  constructor(opts: WSBridgeOptions) {
    this.port = opts.port ?? 3100;
    this.sm = opts.stateMachine;
    this.intervalMs = Math.round(1000 / (opts.publishRateHz ?? 30));
  }

  async start(): Promise<void> {
    if (this.wss) return;

    // Subscribe to state changes so we always have the latest event cached.
    this.unsubscribe = this.sm.onStateChange((e) => {
      this.lastEvent = e;
    });

    this.httpServer = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: "/audio",
    });

    this.wss.on("connection", (_ws: WebSocket, _req: IncomingMessage) => {
      // Send an initial frame immediately so the client knows current state.
      const frame = this.buildFrame();
      _ws.send(JSON.stringify(frame));
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.port, () => resolve());
      this.httpServer!.once("error", reject);
    });

    // Start the publish loop.
    this.timer = setInterval(() => this.broadcast(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.unsubscribe?.();
    this.unsubscribe = null;

    // Close all client connections.
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close(1001, "server shutting down");
      }
    }

    await new Promise<void>((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          this.wss = null;
          resolve();
        });
      } else {
        resolve();
      }
    });

    await new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => {
          this.httpServer = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  clientCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  private buildFrame(): NchindaWaveState {
    return {
      state: this.sm.getState(),
      rms: this.sm.getRms(),
      caption: this.lastEvent?.caption,
      lastEventAt: (this.lastEvent?.ts ?? new Date()).toISOString(),
    };
  }

  private broadcast(): void {
    if (!this.wss || this.wss.clients.size === 0) return;

    const frame = JSON.stringify(this.buildFrame());

    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(frame);
      }
    }
  }
}
