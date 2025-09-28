/**
 * Defines the shape of the environment bindings available to the Cloudflare Worker.
 * This includes secrets, service bindings (D1, KV, DO, AI), and configuration variables.
 */
export interface Env {
  /** The base URL of the Home Assistant instance (e.g., "http://homeassistant.local:8123"). */
  HASSIO_URL: string;
  /** A long-lived access token for authenticating with the Home Assistant API. */
  HASSIO_LONG_LIVED_TOKEN: string;
  /** A secret API key required to authenticate with this worker's own API endpoints. */
  WORKER_API_KEY: string;
  /** The Durable Object namespace for managing the persistent Home Assistant WebSocket connection. */
  HA_WEBSOCKET_DO: DurableObjectNamespace;
  /** The D1 database binding for the cloned Home Assistant recorder data. */
  RECORDER_DB: D1Database;
  /** The D1 database binding for storing worker-specific configuration, like entity profiles and rules. */
  CONFIG_DB: D1Database;
  /** The KV namespace used for storing agent conversation memory and daily reports. */
  MEMORY_KV: KVNamespace;
  /** The binding for the Cloudflare Workers AI service. */
  AI: Ai;
  /** The Fetcher binding for serving static assets (e.g., a frontend application). */
  ASSETS: Fetcher;
  /** The cron schedule string that triggers the worker's scheduled tasks (e.g., "0 12 * * *"). */
  CRON_SCHEDULE: string;
  /** The base system prompt that provides instructions to the AI agent. */
  AGENT_SYSTEM_PROMPT: string;
}

/**
 * Defines the interface for the Cloudflare Workers AI binding.
 */
export interface Ai {
  /**
   * Runs an AI model with the given input.
   * @param {string} model - The identifier of the model to run (e.g., "@cf/meta/llama-3-8b-instruct").
   * @param {Record<string, unknown>} input - The input data for the model.
   * @returns {Promise<unknown>} A promise that resolves to the model's output.
   */
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
