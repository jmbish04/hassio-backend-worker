import type { Env } from "../types";
import { HomeAssistantClient } from "../lib/haClient";

type ClientSocket = WebSocket & { id?: string };

export class HAWebsocketDurableObject {
  private clients = new Set<ClientSocket>();
  private haSocket: WebSocket | null = null;
  private haConnected = false;
  private readonly haClient: HomeAssistantClient;

  constructor(private readonly state: DurableObjectState, env: Env) {
    this.haClient = new HomeAssistantClient(env);
    this.state.blockConcurrencyWhile(async () => {
      await this.ensureHaConnection();
    });
  }

  private async ensureHaConnection(): Promise<void> {
    if (this.haSocket && this.haConnected) {
      return;
    }

    const wsUrl = await this.haClient.websocketUrl();
    const pair = new WebSocketPair();

    const init: RequestInit = {};
    (init as unknown as { webSocket: WebSocket }).webSocket = pair[0];
    const response = await fetch(wsUrl, init);

    const haSocket = response.webSocket;
    if (!haSocket) {
      throw new Error("Failed to establish Home Assistant websocket");
    }

    haSocket.accept();
    this.haSocket = haSocket;
    this.haConnected = true;

    haSocket.addEventListener("message", (event) => {
      for (const client of this.clients) {
        try {
          client.send(event.data);
        } catch (error) {
          console.error("Failed to relay HA message", error);
        }
      }
    });

    haSocket.addEventListener("close", () => {
      this.haConnected = false;
      this.haSocket = null;
      for (const client of this.clients) {
        try {
          client.close(1012, "Home Assistant websocket closed");
        } catch (error) {
          console.error("Failed to close client socket", error);
        }
      }
      this.clients.clear();
    });

    haSocket.addEventListener("error", () => {
      this.haConnected = false;
    });

    haSocket.send(JSON.stringify(this.haClient.buildWebsocketAuthMessage()));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/connect":
        return this.handleConnect();
      case "/status":
        return new Response(
          JSON.stringify({
            clients: this.clients.size,
            connected: this.haConnected,
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  private async handleConnect(): Promise<Response> {
    await this.ensureHaConnection();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.attachClient(server as ClientSocket);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private attachClient(socket: ClientSocket): void {
    socket.accept();
    socket.id = crypto.randomUUID();
    this.clients.add(socket);

    socket.addEventListener("message", (event) => {
      if (!this.haSocket || this.haSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      try {
        this.haSocket.send(event.data);
      } catch (error) {
        console.error("Failed to forward client message", error);
      }
    });

    socket.addEventListener("close", () => {
      this.clients.delete(socket);
    });

    socket.send(
      JSON.stringify({
        type: "connection_info",
        message: "Proxy connected to Home Assistant",
        clientId: socket.id,
        connected: this.haConnected,
      }),
    );
  }
}
