import { z } from "zod";
import type { Env } from "../types";
import { HomeAssistantClient } from "./haClient";

export interface AgentMemoryRecord {
  id: string;
  type: "short" | "long";
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

const AgentRequestSchema = z.object({
  prompt: z.string(),
  sessionId: z.string().optional(),
  context: z.record(z.any()).optional(),
  instructions: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

export class HassAgent {
  constructor(private readonly env: Env) {}

  private async fetchMemories(sessionId: string | undefined): Promise<AgentMemoryRecord[]> {
    if (!sessionId) return [];
    const raw = await this.env.MEMORY_KV.get<AgentMemoryRecord[]>(`memory:${sessionId}`, { type: "json" });
    return raw ?? [];
  }

  private async persistMemory(sessionId: string | undefined, memory: AgentMemoryRecord): Promise<void> {
    if (!sessionId) return;
    const current = await this.fetchMemories(sessionId);
    current.push(memory);
    await this.env.MEMORY_KV.put(`memory:${sessionId}`, JSON.stringify(current), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  async chat(request: unknown): Promise<Response> {
    const parsed = AgentRequestSchema.safeParse(request);
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.message }), { status: 400 });
    }

    const { prompt, sessionId, context, instructions, tools } = parsed.data;
    const ha = new HomeAssistantClient(this.env);

    const memories = await this.fetchMemories(sessionId);
    const haContext = context ?? {};

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

  private async handlePotentialCommand(message: string, ha: HomeAssistantClient): Promise<void> {
    const sanitized = message.toLowerCase();
    const result = await this.env.CONFIG_DB.prepare(
      `SELECT entity_id, nickname FROM entity_profiles WHERE lower(nickname) = lower(?) LIMIT 1`,
    )
      .bind(message.match(/"([^"]+)"/)?.[1] ?? sanitized.replace(/.*\bturn (?:on|off) (?:the )?/, ""))
      .first<{ entity_id: string; nickname: string }>();

    if (!result?.entity_id) return;

    const domain = result.entity_id.split(".")[0];
    const action = sanitized.includes("turn on") ? "turn_on" : sanitized.includes("turn off") ? "turn_off" : undefined;
    if (!action) return;

    await ha.callService(domain, action, { entity_id: result.entity_id });
    await this.env.CONFIG_DB.prepare(
      `INSERT INTO agent_rules(rule_name, trigger_type, trigger_config, response_template, last_triggered)
       VALUES (?, 'agent_command', json(?), ?, CURRENT_TIMESTAMP)
       ON CONFLICT(rule_name) DO UPDATE SET last_triggered = CURRENT_TIMESTAMP`
        ).bind(
          `last_action_${result.entity_id}`,
          JSON.stringify({ entity: result.entity_id, action }),
          message,
        ).run();
  }
}
