/**
 * @file This is the main entry point for the Cloudflare Worker.
 * It defines all API routes using `itty-router`, handles authentication,
 * and orchestrates interactions with Home Assistant, Durable Objects, D1, KV, and the AI service.
 */

import { Router } from "itty-router";
import type { Env } from "./types";
import { HomeAssistantClient } from "./lib/haClient";
import { HassAgent } from "./lib/agent";

const router = Router();

/**
 * A helper function to create a Response object with a JSON body and appropriate headers.
 * @param {unknown} data - The data to be serialized into JSON.
 * @param {ResponseInit} [init={}] - Optional response initialization options.
 * @returns {Response} A Response object.
 */
const json = (data: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers,
    status: init.status ?? 200,
  });
};

/** Type alias for a standard request handler. */
type Handler = (request: Request & { params?: Record<string, string> }, env: Env, ctx: ExecutionContext) => Promise<Response> | Response;

/** Type alias for a handler that requires authentication. */
type AuthenticatedHandler = Handler;

/**
 * A middleware function that wraps a handler to enforce API key authentication.
 * It checks for an API key in the headers before allowing the handler to execute.
 * @param {AuthenticatedHandler} handler - The handler to protect with authentication.
 * @returns {Handler} The wrapped handler with the authentication check.
 */
const withAuth = (handler: AuthenticatedHandler): Handler => {
  return async (request, env, ctx) => {
    const apiKey = extractApiKey(request.headers);
    if (!apiKey || apiKey !== env.WORKER_API_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    return handler(request, env, ctx);
  };
};

/**
 * Extracts an API key from request headers.
 * It checks for 'x-worker-api-key' or 'Authorization: Bearer <key>'.
 * @param {Headers} headers - The request headers.
 * @returns {string | null} The extracted API key or null if not found.
 */
const extractApiKey = (headers: Headers): string | null => {
  const headerKey = headers.get("x-worker-api-key");
  if (headerKey) return headerKey;
  const auth = headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  return null;
};

/**
 * GET /api/status
 * Provides a health check of the worker and its connected services.
 */
router.get(
  "/api/status",
  withAuth(async (request, env) => {
    const haClient = new HomeAssistantClient(env);
    const id = env.HA_WEBSOCKET_DO.idFromName("ha-core");
    const stub = env.HA_WEBSOCKET_DO.get(id);

    const [haResponse, doResponse, entityProfileCount] = await Promise.all([
      haClient.rest("/api/"),
      stub.fetch("https://do/status").then((resp) => resp.json().catch(() => ({ connected: false }))),
      env.CONFIG_DB.prepare("SELECT COUNT(*) as count FROM entity_profiles").first<{ count: number }>(),
    ]);

    return json({
      ha: haResponse.data,
      websocket: doResponse,
      config: {
        entityProfiles: entityProfileCount?.count ?? 0,
      },
      cronSchedule: env.CRON_SCHEDULE,
    });
  }),
);

/**
 * ALL /api/ha/rest/*
 * Acts as an authenticated proxy to the Home Assistant REST API.
 */
router.all(
  "/api/ha/rest/*",
  withAuth(async (request, env) => {
    const haClient = new HomeAssistantClient(env);
    const haPath = request.params?.["*"] ?? "";
    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams.entries());
    let body: BodyInit | undefined;
    let contentType = request.headers.get("content-type") ?? "";

    if (!contentType && request.method !== "GET" && request.method !== "HEAD") {
      contentType = "application/json";
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      if (contentType.includes("application/json")) {
        body = JSON.stringify(await request.json().catch(() => ({}))); // swallow invalid json
      } else if (contentType.startsWith("text/")) {
        body = await request.text();
      } else {
        body = await request.arrayBuffer();
      }
    }

    const upstream = await haClient.rest(`/api/${haPath}`, {
      method: request.method,
      body,
      headers: contentType ? { "Content-Type": contentType } : undefined,
      query,
    });

    const responseHeaders = new Headers(upstream.headers);
    if (!responseHeaders.has("content-type")) {
      responseHeaders.set("content-type", "application/json");
    }

    const data = typeof upstream.data === "string" ? upstream.data : JSON.stringify(upstream.data);
    return new Response(data, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }),
);

/**
 * GET /api/ha/websocket
 * Upgrades the HTTP request to a WebSocket connection, managed by a Durable Object.
 */
router.get(
  "/api/ha/websocket",
  withAuth(async (request, env) => {
    const id = env.HA_WEBSOCKET_DO.idFromName("ha-core");
    const stub = env.HA_WEBSOCKET_DO.get(id);
    const response = await stub.fetch("https://do/connect");
    const socket = response.webSocket;
    if (!socket) {
      return new Response("Failed to establish websocket", { status: 500 });
    }
    return new Response(null, { status: 101, webSocket: socket });
  }),
);

/**
 * POST /api/agent/chat
 * Main endpoint for interacting with the AI agent.
 */
router.post(
  "/api/agent/chat",
  withAuth(async (request, env) => {
    const payload = await request.json().catch(() => ({}));
    const agent = new HassAgent(env);
    return agent.chat(payload);
  }),
);

/**
 * GET /api/entities
 * Retrieves all configured entity profiles from the database.
 */
router.get(
  "/api/entities",
  withAuth(async (request, env) => {
    const { results } = await env.CONFIG_DB.prepare(
      "SELECT entity_id, nickname, room, preferred_actions AS preferredActions, metadata FROM entity_profiles",
    ).all();
    return json({ entities: results });
  }),
);

/**
 * POST /api/entities
 * Creates or updates one or more entity profiles in the database.
 */
router.post(
  "/api/entities",
  withAuth(async (request, env) => {
    const payload = await request.json();
    const entities = Array.isArray(payload) ? payload : [payload];
    const stmt = env.CONFIG_DB.prepare(
      `INSERT INTO entity_profiles(entity_id, nickname, room, preferred_actions, metadata)
       VALUES (?1, ?2, ?3, json(?4), json(?5))
       ON CONFLICT(entity_id) DO UPDATE SET nickname = excluded.nickname, room = excluded.room,
       preferred_actions = excluded.preferred_actions, metadata = excluded.metadata`,
    );

    for (const entity of entities) {
      await stmt
        .bind(
          entity.entity_id,
          entity.nickname ?? null,
          entity.room ?? null,
          JSON.stringify(entity.preferred_actions ?? []),
          JSON.stringify(entity.metadata ?? {}),
        )
        .run();
    }

    return json({ success: true, updated: entities.length }, { status: 201 });
  }),
);

/**
 * GET /api/energy/summary
 * Retrieves a summary of recent energy statistics from the recorder database.
 */
router.get(
  "/api/energy/summary",
  withAuth(async (request, env) => {
    const { results } = await env.RECORDER_DB.prepare(
      `SELECT m.statistic_id as statisticId, m.name, m.unit_of_measurement as unit, s.start, s.mean, s.sum
       FROM statistics s
       JOIN statistics_meta m ON s.metadata_id = m.id
       WHERE m.statistic_id LIKE 'sensor.energy%'
       ORDER BY s.start DESC
       LIMIT 100`,
    ).all();

    return json({ energy: results });
  }),
);

/**
 * GET /api/logs/errors
 * Fetches the plain text error log from Home Assistant.
 */
router.get(
  "/api/logs/errors",
  withAuth(async (request, env) => {
    const haClient = new HomeAssistantClient(env);
    const response = await haClient.rest<string>("/api/error_log");
    return new Response(response.data, {
      status: response.status,
      headers: { "Content-Type": "text/plain" },
    });
  }),
);

/**
 * GET /api/security/camera/:entityId/still
 * Fetches a still JPEG image from a specified camera entity.
 */
router.get(
  "/api/security/camera/:entityId/still",
  withAuth(async (request, env) => {
    const entityId = request.params?.entityId;
    if (!entityId) {
      return new Response("Entity not provided", { status: 400 });
    }

    const haClient = new HomeAssistantClient(env);
    const response = await haClient.streamCamera(entityId);
    return new Response(response.body, {
      headers: { "Content-Type": response.headers.get("Content-Type") ?? "image/jpeg" },
    });
  }),
);

/**
 * POST /api/security/camera/:entityId/analyze
 * Fetches a camera image and sends it to a vision AI model for analysis.
 */
router.post(
  "/api/security/camera/:entityId/analyze",
  withAuth(async (request, env) => {
    const entityId = request.params?.entityId;
    if (!entityId) {
      return new Response("Entity not provided", { status: 400 });
    }

    const payload = (await request.json().catch(() => ({ prompt: "Analyze scene" }))) as Partial<{
      prompt: string;
      metadata: Record<string, unknown>;
    }>;
    const prompt = payload.prompt ?? "Analyze scene";
    const metadata = payload.metadata;
    const haClient = new HomeAssistantClient(env);
    const imageResponse = await haClient.streamCamera(entityId);
    const buffer = await imageResponse.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

    const result = await env.AI.run("@cf/unum/uform-gen2-qwen-500m", {
      prompt,
      image: [{ data: base64, mime: imageResponse.headers.get("Content-Type") ?? "image/jpeg" }],
      metadata,
    });

    return json({ result, entityId });
  }),
);

/**
 * POST /api/automations
 * Creates a new automation blueprint in the configuration database.
 */
router.post(
  "/api/automations",
  withAuth(async (request, env) => {
    const payload = (await request.json()) as {
      name: string;
      description?: string;
      ha_payload?: unknown;
      worker_payload?: unknown;
    };
    const { name, description, ha_payload: haPayload, worker_payload: workerPayload } = payload;

    await env.CONFIG_DB.prepare(
      `INSERT INTO automation_blueprints(name, description, ha_payload, worker_payload)
       VALUES (?1, ?2, json(?3), json(?4))`,
    )
      .bind(name, description ?? null, JSON.stringify(haPayload ?? {}), JSON.stringify(workerPayload ?? {}))
      .run();

    return json({ success: true }, { status: 201 });
  }),
);

/**
 * POST /api/automations/install
 * Installs or triggers an automation by calling a Home Assistant service.
 */
router.post(
  "/api/automations/install",
  withAuth(async (request, env) => {
    const payload = (await request.json()) as {
      domain: string;
      service: string;
      data?: Record<string, unknown>;
      persist?: boolean;
    };
    const { domain, service, data, persist } = payload;
    const haClient = new HomeAssistantClient(env);
    const response = await haClient.callService(domain, service, data ?? {});

    if (persist) {
      await env.CONFIG_DB.prepare(
        `INSERT INTO agent_rules(rule_name, trigger_type, trigger_config, response_template, last_triggered)
         VALUES (?1, 'automation', json(?2), ?, CURRENT_TIMESTAMP)`,
      )
        .bind(`install_${domain}_${service}`, JSON.stringify(data ?? {}), JSON.stringify(response.data))
        .run();
    }

    return json({ status: response.status, data: response.data });
  }),
);

/**
 * POST /api/hooks/trigger
 * A webhook receiver to ingest external events, secured by a query parameter secret.
 */
router.post("/api/hooks/trigger", async (request, env, ctx) => {
  // Webhooks are allowed without API key but validated with secret query param.
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== env.WORKER_API_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const eventType = typeof payload.type === "string" ? payload.type : "worker_event";
  ctx.waitUntil(
    env.RECORDER_DB.prepare(
      `INSERT INTO events(event_type, event_data, origin, time_fired)
       VALUES (?1, ?2, 'worker', CURRENT_TIMESTAMP)`,
    )
      .bind(eventType, JSON.stringify(payload))
      .run(),
  );

  return json({ received: true });
});

/**
 * GET /api/agent/memories/:sessionId
 * Retrieves the conversation history for a specific agent session.
 */
router.get(
  "/api/agent/memories/:sessionId",
  withAuth(async (request, env) => {
    const sessionId = request.params?.sessionId;
    if (!sessionId) {
      return new Response("Session not provided", { status: 400 });
    }
    const memories = await env.MEMORY_KV.get<unknown[]>(`memory:${sessionId}`, { type: "json" });
    return json({ sessionId, memories: memories ?? [] });
  }),
);

/**
 * GET /api/analytics/daily
 * Fetches daily analytics, including scheduled tasks and recent event activity.
 */
router.get(
  "/api/analytics/daily",
  withAuth(async (request, env) => {
    const { results } = await env.CONFIG_DB.prepare(
      `SELECT task, configuration, created_at FROM cron_jobs WHERE enabled = 1 ORDER BY id DESC LIMIT 50`,
    ).all();
    const analytics = await env.RECORDER_DB.prepare(
      `SELECT event_type, COUNT(*) as count FROM events WHERE time_fired >= datetime('now', '-1 day') GROUP BY event_type`,
    ).all();
    return json({ scheduled: results, activity: analytics.results });
  }),
);

/**
 * ALL *
 * A catch-all route to serve static assets for GET/HEAD requests, otherwise returns 404.
 */
router.all("*", async (request, env) => {
  if (request.method === "GET" || request.method === "HEAD") {
    return env.ASSETS.fetch(request);
  }
  return new Response("Not found", { status: 404 });
});

export default {
  /**
   * The main entry point for all incoming HTTP requests to the Worker.
   * @param {Request} request - The incoming request.
   * @param {Env} env - The environment bindings.
   * @param {ExecutionContext} ctx - The execution context.
   * @returns {Promise<Response> | Response} The response to the request.
   */
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname.startsWith("/openapi")) {
      // Allow unauthenticated access to static documentation.
      return env.ASSETS.fetch(request);
    }
    return router.handle(request, env, ctx);
  },

  /**
   * The entry point for scheduled (cron) events.
   * @param {ScheduledController} controller - The controller for the scheduled event.
   * @param {Env} env - The environment bindings.
   * @param {ExecutionContext} ctx - The execution context.
   * @returns {Promise<void>}
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!controller.cron || controller.cron !== env.CRON_SCHEDULE) {
      return;
    }

    const haClient = new HomeAssistantClient(env);
    const energy = await env.RECORDER_DB.prepare(
      `SELECT m.name, s.sum FROM statistics s JOIN statistics_meta m ON s.metadata_id = m.id
       WHERE s.start >= datetime('now', '-1 day') AND m.statistic_id LIKE 'sensor.energy%'
       ORDER BY s.start DESC`,
    ).all();

    const logs = await haClient.rest<string>("/api/error_log");

    const report = {
      generatedAt: new Date().toISOString(),
      energy: energy.results,
      errors: logs.data?.split("\n").slice(0, 50) ?? [],
    };

    // Store the daily report in KV for 7 days.
    ctx.waitUntil(env.MEMORY_KV.put(`daily-report:${report.generatedAt}`, JSON.stringify(report), { expirationTtl: 60 * 60 * 24 * 7 }));
  },
};

export { HAWebsocketDurableObject } from "./durable/haWebsocket";
