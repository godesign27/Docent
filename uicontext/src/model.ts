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

  constructor(options: { model?: string; apiKey?: string } = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ModelUnavailable("No Anthropic API key. Set ANTHROPIC_API_KEY in the environment before drafting.");
    this.name = options.model ?? ClaudeModel.DEFAULT_MODEL;
    this.client = new Anthropic({ apiKey });
  }

  async complete<T>(request: ModelRequest<T>): Promise<T> {
    let response;
    try {
      response = await this.client.messages.parse({
        model: this.name,
        max_tokens: 16000,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
        thinking: { type: "adaptive" },
        output_config: { format: zodOutputFormat(request.schema) },
      });
    } catch (err) {
      throw new ModelUnavailable(`The ${request.purpose} pass could not be run: ${(err as Error).message}`);
    }
    if (response.stop_reason === "refusal") throw new ModelUnavailable(`The model declined the ${request.purpose} pass: ${response.stop_details?.explanation ?? "no explanation given"}.`);
    if (response.stop_reason === "max_tokens") throw new ModelUnavailable(`The ${request.purpose} pass was cut off at the token limit, so its ${request.schemaName} is incomplete.`);
    if (!response.parsed_output) throw new ModelUnavailable(`The ${request.purpose} pass did not return a valid ${request.schemaName}.`);
    return response.parsed_output as T;
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
