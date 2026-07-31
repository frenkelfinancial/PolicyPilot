// ============================================================
// anthropic-chat.ts — a conversational Claude call with tools.
//
// The sibling of anthropic.ts, which is an EXTRACTION client: one shot, a JSON
// schema, no history, no tools. This one holds a conversation and can be
// handed tools. Same secret (ANTHROPIC_API_KEY), same provider, same fast tier
// — the reference the prompt points at, extended rather than re-invented.
//
// Deliberately thin. No streaming (a text message is not streamed to a phone),
// no prompt caching (Haiku 4.5's minimum cacheable prefix is ~4096 tokens and
// a texting prompt is far shorter — the same reasoning as anthropic.ts), and
// no retry loop: an inbound text that fails to get an answer is surfaced to
// the agent, which is a better outcome than a slow duplicate.
// ============================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
/** Fast tier. A texting reply is one or two sentences and has a person waiting. */
export const CHAT_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 512;

export interface ChatMessage {
  role: "user" | "assistant";
  // deno-lint-ignore no-explicit-any
  content: any;
}

export interface ChatTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  toolUses: ChatToolUse[];
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  /** The raw content blocks, so a tool_result turn can quote them back. */
  // deno-lint-ignore no-explicit-any
  content: any[];
}

export async function chat(opts: {
  apiKey: string;
  system: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<ChatResult> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    signal: opts.signal,
    body: JSON.stringify({
      model: CHAT_MODEL,
      max_tokens: opts.maxTokens ?? MAX_TOKENS,
      system: opts.system,
      messages: opts.messages,
      ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
    }),
  });

  const data = await res.json();
  if (!res.ok || data.type === "error") {
    throw new Error(`anthropic_error: ${data?.error?.message ?? res.status}`);
  }
  // A refusal is not an outage — it is the model declining, and the caller
  // hands the thread to the agent rather than sending anything.
  if (data.stop_reason === "refusal") throw new Error("anthropic_refusal");

  const content = data.content ?? [];
  const text = content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("")
    .trim();
  const toolUses: ChatToolUse[] = content
    .filter((b: { type: string }) => b.type === "tool_use")
    .map((b: { id: string; name: string; input: Record<string, unknown> }) => ({
      id: b.id,
      name: b.name,
      input: b.input || {},
    }));

  return {
    text,
    toolUses,
    stopReason: data.stop_reason ?? null,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    content,
  };
}

/**
 * The two tools the texting agent gets.
 *
 * book_appointment takes the lead's OWN WORDS rather than a parsed timestamp,
 * for the same reason the voice tool does: the model is a bad clock and
 * parseAppointmentTime() in _shared/ai-appointment.ts is a tested one. Letting
 * the model emit an ISO instant is how a lead gets booked into next year.
 */
export const SMS_AI_TOOLS: ChatTool[] = [
  {
    name: "book_appointment",
    description:
      "Book the appointment once the person has agreed to a specific day and time. " +
      "Pass their own words exactly as they wrote them — do not convert to a date or time yourself.",
    input_schema: {
      type: "object",
      properties: {
        datetime_text: {
          type: "string",
          description: 'What they agreed to, in their words — e.g. "Tuesday at 2", "tomorrow morning".',
        },
        notes: { type: "string", description: "Anything the agent should know before the appointment." },
        person_name: { type: "string", description: "Their name, if they gave it and we did not already have it." },
      },
      required: ["datetime_text"],
    },
  },
  {
    name: "flag_for_agent",
    description:
      "Flag this conversation for the human agent when the person asks for a call, asks for a person, " +
      "or is clearly ready to move forward. Keep talking to them warmly afterwards — do not go silent.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: 'A few words on why, for the agent\'s alert — e.g. "asking about pricing".',
        },
      },
      required: ["reason"],
    },
  },
];
