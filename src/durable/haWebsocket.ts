/**
 * @file This file defines the Durable Object responsible for managing a single,
 * persistent WebSocket connection to Home Assistant and multiplexing it to multiple clients.
 */

import type { Env } from "../types";
import { HomeAssistantClient } from "../lib/haClient";

/** A client WebSocket connection with an optional unique identifier. */
type ClientSocket = WebSocket & { id?: string };

/**
 * A Durable Object that maintains a single, persistent WebSocket connection
 * to a Home Assistant instance and acts as a proxy for multiple clients.
 * This prevents re-authentication for every client and provides a stable connection point.
 */
export class HAWebsocketDurableObject {
  /** A set of all connected client WebSockets. */
  private clients = new Set<ClientSocket>();
  /** The single, upstream WebSocket connection to Home Assistant. */
  private haSocket: WebSocket | null = null;
  /** A boolean flag indicating the status of the connection to Home Assistant. */
  private haConnected = false;
  /** An instance of the Home Assistant API client. */
  private readonly haClient: HomeAssistantClient;

  /**
   * Initializes the Durable Object state and environment.
   * @param {DurableObjectState} state - The Durable Object's state and storage.
   * @param {Env} env - The worker's environment bindings.
   */
  constructor(private readonly state: DurableObjectState, env: Env) {
    this.haClient = new HomeAssistantClient(env);
    // Ensure the connection to Home Assistant is established as soon as the object is created.
    this.state.blockConcurrencyWhile(async () => {
      await this.ensureHaConnection();
    });
  }

  /**
   * Establishes and maintains the upstream WebSocket connection to Home Assistant.
   * If a connection is already active, this method does nothing.
   * It sets up event listeners to relay messages from Home Assistant to all clients
   * and to handle disconnection events gracefully.
   * @private
   * @returns {Promise<void>}
   */
  private async ensureHaConnection(): Promise<void> {
    if (this.haSocket && this.haConnected) {
      return;
    }

    const wsUrl = await this.haClient.websocketUrl();
    const pair = new WebSocketPair();

    // The `webSocket` property is not in the standard RequestInit type but is used by Cloudflare Workers.
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

    // Listen for messages from Home Assistant and broadcast them to all connected clients.
    haSocket.addEventListener("message", (event) => {
      for (const client of this.clients) {
        try {
          client.send(event.data);
        } catch (error) {
          console.error("Failed to relay HA message", error);
        }
      }
    });

    // Handle the upstream connection closing.
    haSocket.addEventListener("close", () => {
      this.haConnected = false;
      this.haSocket = null;
      // Close all client connections and clear the client set.
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

    // Authenticate with Home Assistant immediately after connecting.
    haSocket.send(JSON.stringify(this.haClient.buildWebsocketAuthMessage()));
  }

  /**
   * The main entry point for HTTP requests to the Durable Object.
   * It routes requests to the appropriate handler based on the URL path.
   * @param {Request} request - The incoming HTTP request.
   * @returns {Promise<Response>} A promise that resolves to the response.
   */
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

  /**
   * Handles a new client's request to establish a WebSocket connection.
   * It ensures the upstream HA connection is active, creates a new WebSocket pair for the client,
   * attaches the server-side socket to the multiplexer, and returns the client-side socket to the user.
   * @private
   * @returns {Promise<Response>} A promise resolving to a 101 Switching Protocols response.
   */
  private async handleConnect(): Promise<Response> {
    await this.ensureHaConnection();

    const pair = new WebSocketPair();
    const client = pair[0]; // This is the client-side socket
    const server = pair[1]; // This is the server-side socket, managed by the DO

    this.attachClient(server as ClientSocket);

    // Return the client-side socket to the user to upgrade their connection.
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Attaches a new client WebSocket to the multiplexer.
   * It adds the client to the active clients set and sets up event listeners
   * to forward messages from the client to Home Assistant.
   * @private
   * @param {ClientSocket} socket - The server-side WebSocket of a new client connection.
   */
  private attachClient(socket: ClientSocket): void {
    socket.accept();
    socket.id = crypto.randomUUID();
    this.clients.add(socket);

    // Listen for messages from the client and forward them to Home Assistant.
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

    // Remove the client from the set when they disconnect.
    socket.addEventListener("close", () => {
      this.clients.delete(socket);
    });

    // Send an initial message to the client confirming the connection status.
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
