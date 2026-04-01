import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";

const execFile = promisify(execFileCallback);

export type ProviderName =
  | "anthropic"
  | "openai"
  | "ollama"
  | "claude-code"
  | "codex";

export type ModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ProviderPolicy = {
  allowSubprocessProviders?: boolean;
  allowLocalHttpProviders?: boolean;
};

export type ModelCallOptions = ProviderPolicy & {
  provider?: ProviderName;
  model: string;
  maxTokens: number;
  temperature?: number;
  baseUrl?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export interface LLMProvider {
  readonly name: ProviderName;
  generate(messages: ModelMessage[], options: ModelCallOptions): Promise<string>;
}

export class ProviderResolutionError extends Error {
  constructor(
    public readonly code:
      | "NO_PROVIDER_AVAILABLE"
      | "PROVIDER_BINARY_NOT_FOUND"
      | "PROVIDER_AUTH_MISSING"
      | "PROVIDER_DISABLED"
      | "PROVIDER_HEALTHCHECK_FAILED"
      | "PROVIDER_INVOCATION_FAILED"
      | "PROVIDER_EMPTY_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "ProviderResolutionError";
  }
}

export type ResolvedProvider = {
  provider: LLMProvider;
  source: "explicit" | "autodetect";
};

const DEFAULT_TIMEOUT_MS = 120_000;

function renderMessagesAsPrompt(messages: ModelMessage[]): string {
  return messages
    .map((message) => `[${message.role.toUpperCase()}]\n${message.content}`)
    .join("\n\n");
}

function extractText(text: string, provider: ProviderName): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new ProviderResolutionError(
      "PROVIDER_EMPTY_RESPONSE",
      `${provider} returned an empty response`,
    );
  }
  return trimmed;
}

function resolveEnv(options: ModelCallOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function checkBinary(binary: string): boolean {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, [binary], { stdio: "ignore" });
  return result.status === 0;
}

async function checkOllamaHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api/tags", baseUrl), { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;

  async generate(messages: ModelMessage[], options: ModelCallOptions): Promise<string> {
    const env = resolveEnv(options);
    const apiKey = env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new ProviderResolutionError(
        "PROVIDER_AUTH_MISSING",
        "ANTHROPIC_API_KEY is required for the anthropic provider",
      );
    }

    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const dialogue = messages
      .filter((message): message is { role: "user" | "assistant"; content: string } => message.role !== "system")
      .map((message) => ({ role: message.role, content: message.content }));

    const client = new Anthropic({
      baseURL: env["ANTHROPIC_BASE_URL"] ?? options.baseUrl,
      apiKey,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: 2,
    });
    const response = await client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? 0,
      ...(system ? { system } : {}),
      messages: dialogue.length > 0 ? dialogue : [{ role: "user", content: "" }],
    });
    return extractText(
      response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join(""),
      this.name,
    );
  }
}

class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;

  async generate(messages: ModelMessage[], options: ModelCallOptions): Promise<string> {
    const env = resolveEnv(options);
    const apiKey = env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new ProviderResolutionError(
        "PROVIDER_AUTH_MISSING",
        "OPENAI_API_KEY is required for the openai provider",
      );
    }

    const response = await fetch(
      new URL("/chat/completions", options.baseUrl ?? env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          temperature: options.temperature ?? 0,
          max_tokens: options.maxTokens,
          messages,
        }),
      },
    );
    if (!response.ok) {
      throw new ProviderResolutionError(
        "PROVIDER_INVOCATION_FAILED",
        `openai provider failed with HTTP ${response.status}`,
      );
    }
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return extractText(content, this.name);
    }
    if (Array.isArray(content)) {
      return extractText(
        content
          .filter((entry) => typeof entry.text === "string")
          .map((entry) => entry.text ?? "")
          .join(""),
        this.name,
      );
    }
    throw new ProviderResolutionError(
      "PROVIDER_EMPTY_RESPONSE",
      "openai provider returned no text content",
    );
  }
}

class OllamaProvider implements LLMProvider {
  readonly name = "ollama" as const;

  async generate(messages: ModelMessage[], options: ModelCallOptions): Promise<string> {
    const host = options.baseUrl ?? resolveEnv(options)["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
    const response = await fetch(new URL("/api/chat", host), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        stream: false,
        options: {
          temperature: options.temperature ?? 0,
          num_predict: options.maxTokens,
        },
        messages,
      }),
    });
    if (!response.ok) {
      throw new ProviderResolutionError(
        "PROVIDER_INVOCATION_FAILED",
        `ollama provider failed with HTTP ${response.status}`,
      );
    }
    const body = await response.json() as { message?: { content?: string } };
    return extractText(body.message?.content ?? "", this.name);
  }
}

abstract class CliProvider implements LLMProvider {
  abstract readonly name: ProviderName;
  abstract readonly binary: string;
  protected abstract buildArgs(prompt: string, options: ModelCallOptions): string[];

  async generate(messages: ModelMessage[], options: ModelCallOptions): Promise<string> {
    if (!checkBinary(this.binary)) {
      throw new ProviderResolutionError(
        "PROVIDER_BINARY_NOT_FOUND",
        `${this.binary} is not available in PATH`,
      );
    }
    const prompt = renderMessagesAsPrompt(messages);
    try {
      const { stdout } = await execFile(this.binary, this.buildArgs(prompt, options), {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      return extractText(stdout, this.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderResolutionError(
        "PROVIDER_INVOCATION_FAILED",
        `${this.name} provider failed: ${message}`,
      );
    }
  }
}

class ClaudeCodeProvider extends CliProvider {
  readonly name = "claude-code" as const;
  readonly binary = "claude";

  protected buildArgs(prompt: string, options: ModelCallOptions): string[] {
    const args = ["-p", prompt];
    if (options.model) {
      args.push("--model", options.model);
    }
    return args;
  }
}

class CodexProvider extends CliProvider {
  readonly name = "codex" as const;
  readonly binary = "codex";

  protected buildArgs(prompt: string, options: ModelCallOptions): string[] {
    const args = ["exec"];
    if (options.model) {
      args.push("--model", options.model);
    }
    args.push(prompt);
    return args;
  }
}

const PROVIDERS: Record<ProviderName, LLMProvider> = {
  anthropic: new AnthropicProvider(),
  openai: new OpenAIProvider(),
  ollama: new OllamaProvider(),
  "claude-code": new ClaudeCodeProvider(),
  codex: new CodexProvider(),
};

function assertAllowedProvider(name: ProviderName, options: ModelCallOptions): void {
  const allowSubprocess = options.allowSubprocessProviders ?? true;
  const allowLocalHttp = options.allowLocalHttpProviders ?? true;
  if ((name === "claude-code" || name === "codex") && !allowSubprocess) {
    throw new ProviderResolutionError(
      "PROVIDER_DISABLED",
      `${name} is disabled in this runtime`,
    );
  }
  if (name === "ollama" && !allowLocalHttp) {
    throw new ProviderResolutionError(
      "PROVIDER_DISABLED",
      "ollama is disabled in this runtime",
    );
  }
}

export async function resolveProvider(options: ModelCallOptions): Promise<ResolvedProvider> {
  const env = resolveEnv(options);
  if (options.provider) {
    assertAllowedProvider(options.provider, options);
    return { provider: PROVIDERS[options.provider], source: "explicit" };
  }

  if (env["ANTHROPIC_API_KEY"]) {
    return { provider: PROVIDERS.anthropic, source: "autodetect" };
  }
  if ((options.allowSubprocessProviders ?? true) && checkBinary("claude")) {
    return { provider: PROVIDERS["claude-code"], source: "autodetect" };
  }
  if ((options.allowSubprocessProviders ?? true) && checkBinary("codex")) {
    return { provider: PROVIDERS.codex, source: "autodetect" };
  }
  if (env["OPENAI_API_KEY"]) {
    return { provider: PROVIDERS.openai, source: "autodetect" };
  }
  if ((options.allowLocalHttpProviders ?? true)) {
    const baseUrl = options.baseUrl ?? env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
    if (await checkOllamaHealth(baseUrl)) {
      return { provider: PROVIDERS.ollama, source: "autodetect" };
    }
  }

  throw new ProviderResolutionError(
    "NO_PROVIDER_AVAILABLE",
    "No LLM provider is available. Configure ANTHROPIC_API_KEY / OPENAI_API_KEY, install claude or codex, or start Ollama.",
  );
}
