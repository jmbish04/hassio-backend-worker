export interface Env {
  HASSIO_URL: string;
  HASSIO_LONG_LIVED_TOKEN: string;
  WORKER_API_KEY: string;
  HA_WEBSOCKET_DO: DurableObjectNamespace;
  RECORDER_DB: D1Database;
  CONFIG_DB: D1Database;
  MEMORY_KV: KVNamespace;
  AI: Ai;
  ASSETS: Fetcher;
  CRON_SCHEDULE: string;
  AGENT_SYSTEM_PROMPT: string;
}

export interface Ai {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
