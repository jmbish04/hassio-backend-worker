import { z } from "zod";
import type { Env } from "../types";
import { HomeAssistantClient } from "./haClient";

/**
 * Represents a single memory record for the agent's conversation history.
 */
export interface AgentMemoryRecord {
  /** A unique identifier for the memory record. */
  id: string;
  /** The type of memory, e.g., short-term or long-term. */
  type: "short" | "long";
  /** The text content of the memory. */
  content: string;
  /** The ISO 8601 timestamp of when the memory was created. */
  createdAt: string;
  /** Optional metadata associated with the memory record. */
  metadata?: Record<string, unknown>;
}

/**
 * Zod schema for validating the structure of incoming agent chat requests.
 */
const AgentRequestSchema = z.object({
  prompt: z.string(),
  sessionId: z.string().optional(),
  context: z.record(z.any()).optional(),
  instructions: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

/**
 * Orchestrates interactions between a user, an AI model, and a Home Assistant instance.
 * It manages conversation memory, context assembly, and command execution.
 */
export class HassAgent {
  /**
   * Initializes a new instance of the HassAgent.
   * @param {Env} env - The Cloudflare Worker environment bindings.
   */
  constructor(private readonly env: Env) {}

  /**
   * Fetches conversation history for a given session from KV storage.
   * @private
   * @param {string | undefined} sessionId - The unique identifier for the conversation session.
   * @returns {Promise<AgentMemoryRecord[]>} A promise that resolves to an array of memory records.
   */
  private async fetchMemories(sessionId: string | undefined): Promise<AgentMemoryRecord[]> {
    if (!sessionId) return [];
    const raw = await this.env.MEMORY_KV.get<AgentMemoryRecord[]>(`memory:${sessionId}`, { type: "json" });
    return raw ?? [];
  }

  /**
   * Persists a new memory record to a session's conversation history in KV storage.
   * @private
   * @param {string | undefined} sessionId - The unique identifier for the conversation session.
   * @param {AgentMemoryRecord} memory - The memory record to save.
   * @returns {Promise<void>}
   */
  private async persistMemory(sessionId: string | undefined, memory: AgentMemoryRecord): Promise<void> {
    if (!sessionId) return;
    const current = await this.fetchMemories(sessionId);
    current.push(memory);
    // Persist for 30 days.
    await this.env.MEMORY_KV.put(`memory:${sessionId}`, JSON.stringify(current), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  /**
   * Handles an incoming chat request from a user.
   * This method validates the request, assembles a prompt with context and memory,
   * invokes the AI model, persists the response, and triggers any detected commands.
   * @param {unknown} request - The raw request body, expected to match AgentRequestSchema.
   * @returns {Promise<Response>} A promise that resolves to a JSON response for the client.
   */
  async chat(request: unknown): Promise<Response> {
    const parsed = AgentRequestSchema.safeParse(request);
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.message }), { status: 400 });
    }

    const { prompt, sessionId, context, instructions, tools } = parsed.data;
    const ha = new HomeAssistantClient(this.env);

    const memories = await this.fetchMemories(sessionId);
    const haContext = context ?? {};

    // Assemble the system prompt with base instructions, user-provided instructions, and recent memory.
    const systemPrompt = [
      this.env.AGENT_SYSTEM_PROMPT,
      instructions,
      memories.length > 0
        ? `Recent short term memory: ${memories.slice(-5).map((m) => `${m.createdAt}: ${m.content}`).join("\n")}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");

    const aiInput = {
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Prompt: ${prompt}\n\nContext: ${JSON.stringify(haContext)}\n\nAvailable tools: ${tools?.join(", ") ?? "none"}`,
        },
      ],
    } satisfies Record<string, unknown>;

    const aiResponse = (await this.env.AI.run("@cf/meta/llama-3-8b-instruct", aiInput)) as { result?: string };
    const message = aiResponse.result ?? "";

    if (sessionId) {
      await this.persistMemory(sessionId, {
        id: crypto.randomUUID(),
        type: "short",
        content: message,
        createdAt: new Date().toISOString(),
      });
    }

    // Check if the AI response looks like a command and handle it.
    if (/turn (on|off)/i.test(message)) {
      await this.handlePotentialCommand(message, ha);
    }

    return new Response(
      JSON.stringify({
        message,
        memories,
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  /**
   * Parses the AI's response to detect and execute a Home Assistant command.
   * It identifies the target entity and action (e.g., turn on/off), calls the
   * relevant Home Assistant service, and logs the action as a new rule.
   * @private
   * @param {string} message - The response message from the AI model.
   * @param {HomeAssistantClient} ha - An instance of the Home Assistant client.
   * @returns {Promise<void>}
   */
  private async handlePotentialCommand(message: string, ha: HomeAssistantClient): Promise<void> {
    const sanitized = message.toLowerCase();
    // Find an entity profile where the nickname matches the target in the AI's response.
    const result = await this.env.CONFIG_DB.prepare(
      `SELECT entity_id, nickname FROM entity_profiles WHERE lower(nickname) = lower(?) LIMIT 1`,
    )
      .bind(message.match(/"([^"]+)"/)?.[1] ?? sanitized.replace(/.*\bturn (?:on|off) (?:the )?/, ""))
      .first<{ entity_id: string; nickname: string }>();

    if (!result?.entity_id) return;

    const domain = result.entity_id.split(".")[0];
    const action = sanitized.includes("turn on") ? "turn_on" : sanitized.includes("turn off") ? "turn_off" : undefined;
    if (!action) return;

    // Execute the service call and log the action as a rule for future reference.
    await ha.callService(domain, action, { entity_id: result.entity_id });
    await this.env.CONFIG_DB.prepare(
      `INSERT INTO agent_rules(rule_name, trigger_type, trigger_config, response_template, last_triggered)
       VALUES (?, 'agent_command', json(?), ?, CURRENT_TIMESTAMP)
       ON CONFLICT(rule_name) DO UPDATE SET last_triggered = CURRENT_TIMESTAMP`,
    )
      .bind(`last_action_${result.entity_id}`, JSON.stringify({ entity: result.entity_id, action }), message)
      .run();
  }
}
