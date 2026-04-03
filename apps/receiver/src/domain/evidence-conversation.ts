export type EvidenceConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

export type IntentProfile = {
  kind: "metrics" | "logs" | "traces" | "root_cause" | "action" | "greeting" | "general";
  preferredSurfaces: Array<"traces" | "metrics" | "logs">;
};
