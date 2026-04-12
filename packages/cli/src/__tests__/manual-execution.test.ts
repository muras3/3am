import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCallModelMessages } = vi.hoisted(() => ({
  mockCallModelMessages: vi.fn(),
}));

vi.mock("3am-diagnosis", async () => {
  const actual = await vi.importActual("3am-diagnosis");
  return {
    ...actual,
    callModelMessages: mockCallModelMessages,
  };
});

import { runManualChat } from "../commands/manual-execution.js";

describe("runManualChat", () => {
  beforeEach(() => {
    mockCallModelMessages.mockReset();
    mockCallModelMessages.mockResolvedValue("ok");
  });

  it("wraps the user message exactly once before calling the model", async () => {
    await runManualChat({
      receiverUrl: "http://localhost:3333",
      incidentId: "inc_000001",
      message: "What happened?",
      history: [],
      provider: "codex",
      systemPrompt: "system prompt",
    });

    const messages = mockCallModelMessages.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "<user_message>What happened?</user_message>" },
    ]);
  });
});
