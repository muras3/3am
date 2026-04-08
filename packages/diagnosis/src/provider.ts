import Anthropic from "@anthropic-ai/sdk";

export type ProviderName =
  | "anthropic"
  | "openai"
  | "ollama"
  | "claude-code"
  | "codex";

export const PROVIDER_NAMES = [
  "anthropic",
  "openai",
  "ollama",
  "claude-code",
  "codex",
] as const satisfies readonly ProviderName[];

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
  model?: string;
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

const DEFAULT_TIMEOUT_MS = 300_000;

export function defaultModelForProvider(
  provider: ProviderName | undefined,
  fallback: string,
): string | undefined {
  if (provider === "claude-code" || provider === "codex") {
    return undefined;
  }
  return fallback;
}

function buildApiBaseUrl(baseUrl: string): URL {
  return new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

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

function authFailureError(provider: ProviderName, detail?: string): ProviderResolutionError {
  const suffix = detail ? `: ${detail}` : "";
  return new ProviderResolutionError(
    "PROVIDER_AUTH_MISSING",
    `${provider} provider authentication failed${suffix}`,
  );
}

function invocationFailureError(provider: ProviderName, detail: string): ProviderResolutionError {
  return new ProviderResolutionError(
    "PROVIDER_INVOCATION_FAILED",
    `${provider} provider failed: ${detail}`,
  );
}

function isAuthFailureStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

function extractErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = Reflect.get(error, "status");
  return typeof status === "number" ? status : undefined;
}

async function checkBinary(binary: string): Promise<boolean> {
  const { spawnSync } = await import("node:child_process");
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
    if (!options.model) {
      throw new ProviderResolutionError(
        "PROVIDER_INVOCATION_FAILED",
        "anthropic provider requires a model",
      );
    }
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
    try {
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
    } catch (error) {
      const status = extractErrorStatus(error);
      if (isAuthFailureStatus(status)) {
        throw authFailureError(this.name, `HTTP ${status}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw invocationFailureError(this.name, message);
    }
  }
}

class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;

  async generate(messages: ModelMessage[], options: ModelCallOptions): Promise<string> {
    const env = resolveEnv(options);
    const apiKey = env["OPENAI_API_KEY"];
    if (!options.model) {
      throw new ProviderResolutionError(
        "PROVIDER_INVOCATION_FAILED",
        "openai provider requires a model",
      );
    }
    if (!apiKey) {
      throw new ProviderResolutionError(
        "PROVIDER_AUTH_MISSING",
        "OPENAI_API_KEY is required for the openai provider",
      );
    }

    const response = await fetch(
      new URL("chat/completions", buildApiBaseUrl(options.baseUrl ?? env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1/")),
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
      if (isAuthFailureStatus(response.status)) {
        throw authFailureError(this.name, `HTTP ${response.status}`);
      }
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
    if (!options.model) {
      throw new ProviderResolutionError(
        "PROVIDER_INVOCATION_FAILED",
        "ollama provider requires a model",
      );
    }
    const host = options.baseUrl ?? resolveEnv(options)["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
    const response = await fetch(new URL("/api/chat", host), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        stream: false,
        think: false,
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
  protected abstract buildArgs(options: ModelCallOptions): string[];
  protected buildSpawnEnv(options: ModelCallOptions): NodeJS.ProcessEnv {
    return { ...resolveEnv(options) };
  }

  async generate(messages: ModelMessage[], options: ModelCallOptions): Promise<string> {
    if (!await checkBinary(this.binary)) {
      throw new ProviderResolutionError(
        "PROVIDER_BINARY_NOT_FOUND",
        `${this.binary} is not available in PATH`,
      );
    }
    const prompt = renderMessagesAsPrompt(messages);
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn(this.binary, this.buildArgs(options), {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.buildSpawnEnv(options),
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
      child.stdin.write(prompt);
      child.stdin.end();

      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`${this.name} provider timed out`));
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });

      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        throw new Error(stderr || `${this.binary} exited with code ${code}`);
      }

      return extractText(Buffer.concat(stdoutChunks).toString("utf8"), this.name);
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

  protected buildArgs(options: ModelCallOptions): string[] {
    const args = ["-p"];
    if (options.model) {
      args.push("--model", options.model);
    }
    return args;
  }

  protected buildSpawnEnv(options: ModelCallOptions): NodeJS.ProcessEnv {
    const env = super.buildSpawnEnv(options);
    delete env["ANTHROPIC_API_KEY"];
    return env;
  }
}

class CodexProvider extends CliProvider {
  readonly name = "codex" as const;
  readonly binary = "codex";

  protected buildArgs(options: ModelCallOptions): string[] {
    const args = ["exec"];
    if (options.model) {
      args.push("--model", options.model);
    }
    args.push("-");
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

function resolved(name: ProviderName, source: ResolvedProvider["source"], options: ModelCallOptions): ResolvedProvider {
  assertAllowedProvider(name, options);
  return { provider: PROVIDERS[name], source };
}

export async function resolveProviderCandidates(options: ModelCallOptions): Promise<ResolvedProvider[]> {
  const env = resolveEnv(options);
  if (options.provider) {
    return [resolved(options.provider, "explicit", options)];
  }

  const candidates: ResolvedProvider[] = [];
  if (env["ANTHROPIC_API_KEY"]) {
    candidates.push(resolved("anthropic", "autodetect", options));
  }
  if ((options.allowSubprocessProviders ?? true) && await checkBinary("claude")) {
    candidates.push(resolved("claude-code", "autodetect", options));
  }
  if ((options.allowSubprocessProviders ?? true) && await checkBinary("codex")) {
    candidates.push(resolved("codex", "autodetect", options));
  }
  if (env["OPENAI_API_KEY"]) {
    candidates.push(resolved("openai", "autodetect", options));
  }
  if ((options.allowLocalHttpProviders ?? true)) {
    const baseUrl = options.baseUrl ?? env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
    if (await checkOllamaHealth(baseUrl)) {
      candidates.push(resolved("ollama", "autodetect", options));
    }
  }

  if (candidates.length > 0) {
    return candidates;
  }

  throw new ProviderResolutionError(
    "NO_PROVIDER_AVAILABLE",
    "No LLM provider is available. Configure ANTHROPIC_API_KEY / OPENAI_API_KEY, install claude or codex, or start Ollama.",
  );
}

export async function resolveProvider(options: ModelCallOptions): Promise<ResolvedProvider> {
  const [provider] = await resolveProviderCandidates(options);
  if (!provider) {
    throw new ProviderResolutionError(
      "NO_PROVIDER_AVAILABLE",
      "No LLM provider is available. Configure ANTHROPIC_API_KEY / OPENAI_API_KEY, install claude or codex, or start Ollama.",
    );
  }
  return provider;
}
