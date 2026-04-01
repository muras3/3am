import type {
  ConsoleNarrative,
  DiagnosisResult,
  IncidentPacket,
  ReasoningStructure,
} from "@3amoncall/core";
import {
  callModelMessages,
  diagnose,
  generateConsoleNarrative,
  type ProviderName,
} from "@3amoncall/diagnosis";

export type ManualExecutionOptions = {
  receiverUrl: string;
  incidentId: string;
  authToken?: string;
  provider?: ProviderName;
  model?: string;
  locale?: "en" | "ja";
};

type ExtendedIncidentPayload = {
  incidentId: string;
  diagnosisResult?: DiagnosisResult;
};

function authHeaders(authToken?: string): Record<string, string> {
  return authToken
    ? { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function buildChatSystemPrompt(dr: DiagnosisResult, locale?: "en" | "ja"): string {
  const chain = dr.reasoning.causal_chain.map((step: DiagnosisResult["reasoning"]["causal_chain"][number]) => step.title).join(" -> ");
  const jaInstruction = locale === "ja"
    ? "\n\nRespond in Japanese. Use concise, operator-actionable language."
    : "";
  return (
    "You are an incident responder assistant. The engineer is investigating an active incident.\n\n" +
    `Incident summary: ${dr.summary.what_happened}\n` +
    `Root cause: ${dr.summary.root_cause_hypothesis}\n` +
    `Recommended action: ${dr.recommendation.immediate_action}\n` +
    `Causal chain: ${chain}\n` +
    `Confidence: ${dr.confidence.confidence_assessment}\n` +
    `Known uncertainty: ${dr.confidence.uncertainty}\n\n` +
    "Answer concisely in 1-3 sentences. If you infer anything, label it as a hypothesis." +
    jaInstruction
  );
}

export async function runManualDiagnosis(options: ManualExecutionOptions): Promise<{
  diagnosis: DiagnosisResult;
  narrative: ConsoleNarrative;
}> {
  const headers = authHeaders(options.authToken);
  const packet = await fetchJson<IncidentPacket>(
    `${options.receiverUrl}/api/incidents/${encodeURIComponent(options.incidentId)}/packet`,
    { headers },
  );
  const reasoning = await fetchJson<ReasoningStructure>(
    `${options.receiverUrl}/api/incidents/${encodeURIComponent(options.incidentId)}/reasoning-structure`,
    { headers },
  );
  const localeResponse = await fetchJson<{ locale?: "en" | "ja" }>(
    `${options.receiverUrl}/api/settings/locale`,
    { headers },
  ).catch(() => ({ locale: "en" as const }));
  const locale = options.locale ?? localeResponse.locale ?? "en";

  const diagnosis = await diagnose(packet, {
    provider: options.provider,
    model: options.model,
    locale,
  });
  const narrative = await generateConsoleNarrative(diagnosis, reasoning, {
    provider: options.provider,
    locale,
  });

  await fetchJson<{ status: string }>(
    `${options.receiverUrl}/api/diagnosis/${encodeURIComponent(options.incidentId)}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(diagnosis),
    },
  );
  await fetchJson<{ status: string }>(
    `${options.receiverUrl}/api/incidents/${encodeURIComponent(options.incidentId)}/console-narrative`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(narrative),
    },
  );

  return { diagnosis, narrative };
}

export async function runManualChat(options: ManualExecutionOptions & {
  message: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ reply: string }> {
  const headers = authHeaders(options.authToken);
  const incident = await fetchJson<ExtendedIncidentPayload>(
    `${options.receiverUrl}/api/incidents/${encodeURIComponent(options.incidentId)}`,
    { headers },
  );
  if (!incident.diagnosisResult) {
    throw new Error("diagnosis is not available for this incident yet");
  }
  const localeResponse = await fetchJson<{ locale?: "en" | "ja" }>(
    `${options.receiverUrl}/api/settings/locale`,
    { headers },
  ).catch(() => ({ locale: "en" as const }));
  const locale = options.locale ?? localeResponse.locale ?? "en";

  const reply = await callModelMessages(
    [
      { role: "system", content: buildChatSystemPrompt(incident.diagnosisResult, locale) },
      ...options.history,
      { role: "user", content: `<user_message>${options.message}</user_message>` },
    ],
    {
      provider: options.provider,
      model: options.model ?? "claude-haiku-4-5-20251001",
      maxTokens: 512,
      temperature: 0.3,
    },
  );

  return { reply };
}
