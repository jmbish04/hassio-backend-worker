import type { Env } from "../types";

type FetchOptions = RequestInit & { query?: Record<string, string | number | boolean | undefined> };

export interface HomeAssistantRestResponse<T = unknown> {
  status: number;
  data: T;
  headers: Headers;
}

export class HomeAssistantClient {
  constructor(private readonly env: Env) {}

  private buildHeaders(init?: RequestInit): Headers {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.env.HASSIO_LONG_LIVED_TOKEN}`);
    headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
    return headers;
  }

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

  async streamCamera(entityId: string): Promise<Response> {
    const url = this.buildUrl(`/api/camera_proxy/${entityId}`);
    return fetch(url, {
      headers: this.buildHeaders(),
    });
  }

  async websocketUrl(): Promise<string> {
    const haUrl = new URL(this.env.HASSIO_URL);
    haUrl.protocol = haUrl.protocol === "https:" ? "wss:" : "ws:";
    haUrl.pathname = "/api/websocket";
    return haUrl.toString();
  }

  buildWebsocketAuthMessage(): Record<string, unknown> {
    return {
      type: "auth",
      access_token: this.env.HASSIO_LONG_LIVED_TOKEN,
    } satisfies Record<string, unknown>;
  }

  async callService(domain: string, service: string, payload: Record<string, unknown> = {}): Promise<HomeAssistantRestResponse>
  {
    return this.rest(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async fireEvent(eventType: string, payload: Record<string, unknown> = {}): Promise<HomeAssistantRestResponse> {
    return this.rest(`/api/events/${eventType}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async converse(prompt: string, context?: Record<string, unknown>): Promise<HomeAssistantRestResponse> {
    return this.rest("/api/conversation/process", {
      method: "POST",
      body: JSON.stringify({ text: prompt, ...context }),
    });
  }
}
