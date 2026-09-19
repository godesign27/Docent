/**
 * The model, behind one narrow interface: a prompt in, a schema-shaped object out.
 *
 * The model never sees a design system it could quote from memory, and it never writes the file —
 * it fills a structure that code renders and checks. Tests run against a scripted model, so a run
 * is deterministic and costs nothing.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export interface ModelRequest<T> {
  /** What this call is for, e.g. "draft". Scripted models answer by purpose. */
  purpose: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Name of the structure being asked for, shown to the model. */
  schemaName: string;
}

export interface Model {
  readonly name: string;
  complete<T>(request: ModelRequest<T>): Promise<T>;
}

/** The model could not be reached, or did not return the structure that was asked for. Never guessed around. */
export class ModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailable";
  }
}

export class ClaudeModel implements Model {
  static readonly DEFAULT_MODEL = "claude-opus-5";
  readonly name: string;
  private readonly client: Anthropic;

  constructor(options: { model?: string; apiKey?: string; workspaceId?: string } = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ModelUnavailable("No Anthropic API key. Set ANTHROPIC_API_KEY in the environment before drafting.");
    // An organisation key that isn't scoped to a workspace has to name one on every request.
    const workspaceId = options.workspaceId ?? process.env.ANTHROPIC_WORKSPACE_ID;
    this.name = options.model ?? ClaudeModel.DEFAULT_MODEL;
    this.client = new Anthropic({ apiKey, ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}) });
  }

  /**
   * Streamed, because a UIContext draft is long and adaptive thinking shares the output budget:
   * at 16k the JSON came back truncated mid-string. A cut-off answer is never patched up — it fails.
   */
  async complete<T>(request: ModelRequest<T>): Promise<T> {
    let response;
    try {
      response = await this.client.messages
        .stream({
          model: this.name,
          max_tokens: 64000,
          system: request.system,
          messages: [{ role: "user", content: request.prompt }],
          thinking: { type: "adaptive" },
          output_config: { format: zodOutputFormat(request.schema) },
        })
        .finalMessage();
    } catch (err) {
      const message = (err as Error).message;
      const hint = message.includes("anthropic-workspace-id")
        ? " Set ANTHROPIC_WORKSPACE_ID to the workspace the key should bill to, or use a workspace-scoped key."
        : "";
      throw new ModelUnavailable(`The ${request.purpose} pass could not be run: ${message}${hint}`);
    }
    if (response.stop_reason === "refusal") throw new ModelUnavailable(`The model declined the ${request.purpose} pass: ${response.stop_details?.explanation ?? "no explanation given"}.`);
    if (response.stop_reason === "max_tokens") throw new ModelUnavailable(`The ${request.purpose} pass was cut off at ${response.usage.output_tokens} output tokens, so its ${request.schemaName} is incomplete.`);

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    try {
      return request.schema.parse(JSON.parse(text));
    } catch (err) {
      throw new ModelUnavailable(`The ${request.purpose} pass did not return a valid ${request.schemaName}: ${(err as Error).message}`);
    }
  }
}

/** Returns prepared answers by purpose. Tests use it; it never reaches the network. */
export class ScriptedModel implements Model {
  readonly name = "scripted";
  readonly requests: ModelRequest<unknown>[] = [];

  constructor(private readonly answers: Record<string, unknown>) {}

  async complete<T>(request: ModelRequest<T>): Promise<T> {
    this.requests.push(request as ModelRequest<unknown>);
    const answer = this.answers[request.purpose];
    if (answer === undefined) throw new ModelUnavailable(`No scripted answer for the "${request.purpose}" pass.`);
    return request.schema.parse(answer);
  }
}
