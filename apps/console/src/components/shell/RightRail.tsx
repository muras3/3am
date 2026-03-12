import { useRef, useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DiagnosisResult } from "../../api/types.js";
import type { CopilotVM } from "../../lib/viewmodels/index.js";
import { sendChatMessage, type ChatTurn } from "../../api/queries.js";
import { DiagnosisPending } from "../common/DiagnosisPending.js";

const QUICK_PROMPTS = [
  "Could this still be deploy-related?",
  "What tells us the action worked?",
  "What competing hypothesis remains?",
];

interface Props {
  incidentId: string;
  diagnosisResult?: DiagnosisResult;
  copilotVM?: CopilotVM;
}

export function RightRail({ incidentId, diagnosisResult, copilotVM }: Props) {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const mutation = useMutation({
    mutationFn: ({ message, hist }: { message: string; hist: ChatTurn[] }) =>
      sendChatMessage(incidentId, message, hist),
    onSuccess: (data, { message, hist }) => {
      setHistory([...hist, { role: "user", content: message }, { role: "assistant", content: data.reply }]);
    },
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  // Reset history when incident changes
  useEffect(() => {
    setHistory([]);
    setInput("");
  }, [incidentId]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || mutation.isPending) return;
    setInput("");
    mutation.mutate({ message: trimmed, hist: history });
  }

  return (
    <aside className="right-rail">
      <div className="copilot-header">
        <h3>AI Copilot</h3>
        {diagnosisResult && <span className="grounded">grounded</span>}
      </div>
      <div className="copilot-body">
        {!diagnosisResult ? (
          <DiagnosisPending />
        ) : history.length === 0 ? (
          <>
            {/* Trust order: uncertainty first, confidence second, operator-check third.
                Prefer copilotVM (derived from VM layer) when available. */}
            <div className="diagnosis-card" data-rail-section="uncertainty">
              <div className="d-label">Uncertainty</div>
              <div className="d-main">
                {copilotVM?.uncertainty ?? diagnosisResult.confidence.uncertainty}
              </div>
            </div>
            <div className="diagnosis-card primary" data-rail-section="confidence">
              <div className="d-label">Confidence Assessment</div>
              <div className="d-main">
                {copilotVM?.confidence ?? diagnosisResult.confidence.confidence_assessment}
              </div>
            </div>
            <div className="diagnosis-card" data-rail-section="operator-check">
              <div className="d-label">Operator Check</div>
              <div className="d-main">
                {copilotVM?.operatorCheck ??
                  diagnosisResult.operator_guidance.operator_checks[0] ??
                  "\u2014"}
              </div>
            </div>
          </>
        ) : (
          <div className="chat-messages" aria-live="polite">
            {history.map((turn, i) => (
              <div key={i} className={`chat-bubble chat-bubble-${turn.role}`}>
                {turn.content}
              </div>
            ))}
            {mutation.isPending && (
              <div className="chat-bubble chat-bubble-assistant chat-thinking">…</div>
            )}
            {mutation.isError && (
              <div className="chat-bubble chat-bubble-error">Failed to get a reply. Try again.</div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>
      <div className="copilot-footer" data-rail-section="chat">
        {diagnosisResult && (
          <>
            <div className="ask-label">Ask About</div>
            <div className="ask-chips">
              {QUICK_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  className="ask-chip"
                  onClick={() => {
                    setInput(prompt);
                    send(prompt);
                  }}
                  disabled={mutation.isPending}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="chat-input-row">
          <input
            className="chat-input-field"
            type="text"
            placeholder="Ask about this incident..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send(input);
            }}
            disabled={mutation.isPending || !diagnosisResult}
            aria-label="Chat input"
          />
          <button
            className="send-btn"
            onClick={() => send(input)}
            disabled={mutation.isPending || !diagnosisResult || !input.trim()}
            aria-label="Send"
          >
            Send
          </button>
        </div>
      </div>
    </aside>
  );
}
