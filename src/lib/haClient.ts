import type { Env } from "../types";

/**
 * Extends the standard RequestInit type to include an optional query object for building URL search parameters.
 */
type FetchOptions = RequestInit & { query?: Record<string, string | number | boolean | undefined> };

/**
 * Defines the standardized structure for responses from the Home Assistant REST API client.
 * @template T The expected type of the response data.
 */
export interface HomeAssistantRestResponse<T = unknown> {
  /** The HTTP status code of the response. */
  status: number;
  /** The parsed response data (JSON or text). */
  data: T;
  /** The response headers. */
  headers: Headers;
}

/**
 * A client for interacting with the Home Assistant REST API and WebSocket services.
 */
export class HomeAssistantClient {
  /**
   * Initializes a new instance of the HomeAssistantClient.
   * @param {Env} env - The Cloudflare Worker environment bindings, containing secrets and configuration.
   */
  constructor(private readonly env: Env) {}

  /**
   * Builds the required headers for API requests, including the Authorization token.
   * @private
   * @param {RequestInit} [init] - Optional initial request configuration.
   * @returns {Headers} A Headers object with authentication and content-type.
   */
  private buildHeaders(init?: RequestInit): Headers {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.env.HASSIO_LONG_LIVED_TOKEN}`);
    headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
    return headers;
  }

  /**
   * Constructs a full URL for a Home Assistant API endpoint.
   * @private
   * @param {string} path - The API endpoint path (e.g., "/api/states").
   * @param {FetchOptions["query"]} [query] - An optional object of query parameters.
   * @returns {string} The complete URL as a string.
   */
  private buildUrl(path: string, query?: FetchOptions["query"]): string {
    const url = new URL(path.replace(/^\/+/, "/"), this.env.HASSIO_URL);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  /**
   * Performs a generic REST API request to the Home Assistant instance.
   * @template T The expected type of the response data.
   * @param {string} path - The API endpoint path.
   * @param {FetchOptions} [init] - Optional request configuration, including method, body, and query params.
   * @returns {Promise<HomeAssistantRestResponse<T>>} A promise that resolves to a standardized response object.
   */
  async rest<T = unknown>(path: string, init?: FetchOptions): Promise<HomeAssistantRestResponse<T>> {
    const url = this.buildUrl(path, init?.query);
    const response = await fetch(url, {
      ...init,
      headers: this.buildHeaders(init),
    });

    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json") ? ((await response.json()) as T) : ((await response.text()) as T);
    return {
      status: response.status,
      data,
      headers: response.headers,
    };
  }

  /**
   * Fetches a live camera stream from Home Assistant.
   * @param {string} entityId - The entity ID of the camera (e.g., "camera.front_door").
   * @returns {Promise<Response>} A promise that resolves to the raw streaming response.
   */
  async streamCamera(entityId: string): Promise<Response> {
    const url = this.buildUrl(`/api/camera_proxy/${entityId}`);
    return fetch(url, {
      headers: this.buildHeaders(),
    });
  }

  /**
   * Constructs the WebSocket URL for the Home Assistant instance.
   * @returns {Promise<string>} A promise that resolves to the `wss://` or `ws://` URL.
   */
  async websocketUrl(): Promise<string> {
    const haUrl = new URL(this.env.HASSIO_URL);
    haUrl.protocol = haUrl.protocol === "https:" ? "wss:" : "ws:";
    haUrl.pathname = "/api/websocket";
    return haUrl.toString();
  }

  /**
   * Builds the initial authentication message for the WebSocket connection.
   * @returns {Record<string, unknown>} The authentication message object.
   */
  buildWebsocketAuthMessage(): Record<string, unknown> {
    return {
      type: "auth",
      access_token: this.env.HASSIO_LONG_LIVED_TOKEN,
    } satisfies Record<string, unknown>;
  }

  /**
   * Calls a specific service within a domain in Home Assistant.
   * @param {string} domain - The service domain (e.g., "light", "switch").
   * @param {string} service - The service to call (e.g., "turn_on", "toggle").
   * @param {Record<string, unknown>} [payload={}] - The service data payload, often containing an `entity_id`.
   * @returns {Promise<HomeAssistantRestResponse>} The API response.
   */
  async callService(domain: string, service: string, payload: Record<string, unknown> = {}): Promise<HomeAssistantRestResponse> {
    return this.rest(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /**
   * Fires a custom event on the Home Assistant event bus.
   * @param {string} eventType - The name of the event to fire.
   * @param {Record<string, unknown>} [payload={}] - The data payload for the event.
   * @returns {Promise<HomeAssistantRestResponse>} The API response.
   */
  async fireEvent(eventType: string, payload: Record<string, unknown> = {}): Promise<HomeAssistantRestResponse> {
    return this.rest(`/api/events/${eventType}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /**
   * Sends a text prompt to the Home Assistant conversation integration.
   * @param {string} prompt - The text to process (e.g., "Turn on the living room lights").
   * @param {Record<string, unknown>} [context] - Optional additional context for the conversation.
   * @returns {Promise<HomeAssistantRestResponse>} The API response containing the conversation result.
   */
  async converse(prompt: string, context?: Record<string, unknown>): Promise<HomeAssistantRestResponse> {
    return this.rest("/api/conversation/process", {
      method: "POST",
      body: JSON.stringify({ text: prompt, ...context }),
    });
  }
}
