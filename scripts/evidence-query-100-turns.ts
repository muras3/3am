#!/usr/bin/env node
/**
 * evidence-query-100-turns.ts — 100-turn Evidence Query UX test
 *
 * Exercises the evidence query API through 100 diverse questions across
 * 10 categories, measuring response time, status, and UX quality.
 *
 * Usage:
 *   RECEIVER_URL=http://localhost:3333 INCIDENT_ID=<id> npx tsx scripts/evidence-query-100-turns.ts
 *
 * Output: JSON results to stdout, summary to stderr.
 */

const RECEIVER_URL = process.env["RECEIVER_URL"] ?? "http://localhost:3333";
const INCIDENT_ID = process.env["INCIDENT_ID"];
const AUTH_TOKEN = process.env["AUTH_TOKEN"];

if (!INCIDENT_ID) {
  console.error("Error: INCIDENT_ID environment variable is required");
  process.exit(1);
}

interface TurnResult {
  turn: number;
  category: string;
  question: string;
  status: string;
  responseTimeMs: number;
  segmentCount: number;
  evidenceRefCount: number;
  followupCount: number;
  clarificationQuestion?: string;
  noAnswerReason?: string;
  uxJudgment: "PASS" | "FAIL";
  uxReason: string;
}

interface EvidenceQueryResponse {
  question: string;
  status: "answered" | "no_answer" | "clarification";
  segments: Array<{
    id: string;
    kind: string;
    text: string;
    evidenceRefs: Array<{ kind: string; id: string }>;
  }>;
  evidenceSummary: { traces: number; metrics: number; logs: number };
  followups: Array<{ question: string; targetEvidenceKinds: string[] }>;
  noAnswerReason?: string;
  clarificationQuestion?: string;
}

// ── Test questions by category ──────────────────────────────────────

const CATEGORIES: Array<{
  name: string;
  questions: Array<{
    text: string;
    locale?: "en" | "ja";
    isFollowup?: boolean;
    replyToClarification?: { originalQuestion: string; clarificationText: string };
    clarificationChainLength?: number;
  }>;
}> = [
  {
    name: "basic",
    questions: [
      { text: "What happened?" },
      { text: "What is the root cause?" },
      { text: "Show me the timeline" },
      { text: "What is the blast radius?" },
      { text: "Which services are affected?" },
      { text: "What triggered this incident?" },
      { text: "How long has this been going on?" },
      { text: "Is this still happening?" },
      { text: "What is the error rate?" },
      { text: "Are there any anomalies?" },
    ],
  },
  {
    name: "followup",
    questions: [
      { text: "Can you explain that in more detail?", isFollowup: true },
      { text: "What about the other services?", isFollowup: true },
      { text: "How does that relate to the metrics?", isFollowup: true },
      { text: "Show me the evidence for that claim", isFollowup: true },
      { text: "What happened before that?", isFollowup: true },
      { text: "Is there anything else unusual?", isFollowup: true },
      { text: "What about the logs?", isFollowup: true },
      { text: "Can you show the trace for that?", isFollowup: true },
      { text: "How confident are you in that assessment?", isFollowup: true },
      { text: "What would disprove this hypothesis?", isFollowup: true },
    ],
  },
  {
    name: "action",
    questions: [
      { text: "What should I do first?" },
      { text: "What is the priority action?" },
      { text: "Should I restart the service?" },
      { text: "What is the recommended next step?" },
      { text: "How do I fix this?" },
      { text: "What should I check next?" },
      { text: "Is there a workaround?" },
      { text: "Should I scale up?" },
      { text: "Do I need to rollback?" },
      { text: "What NOT to do?" },
    ],
  },
  {
    name: "reference_resolution",
    questions: [
      {
        text: "1",
        replyToClarification: {
          originalQuestion: "What went wrong?",
          clarificationText: "1. The trace path showing the failure\n2. The metric anomaly\n3. The log error pattern",
        },
      },
      {
        text: "1と2",
        locale: "ja",
        replyToClarification: {
          originalQuestion: "何が問題？",
          clarificationText: "1. トレースの失敗経路\n2. メトリクスの異常\n3. ログのエラーパターン",
        },
      },
      {
        text: "(1) and (3)",
        replyToClarification: {
          originalQuestion: "What should I look at?",
          clarificationText: "1) Trace spans with errors\n2) Metric deviations\n3) Log clusters",
        },
      },
      {
        text: "2",
        replyToClarification: {
          originalQuestion: "Which area?",
          clarificationText: "1: Network latency\n2: Database queries\n3: External API calls",
        },
      },
      {
        text: "I want to see the latency details",
        replyToClarification: {
          originalQuestion: "What aspect?",
          clarificationText: "Could you be more specific?",
        },
      },
      { text: "Tell me more about that", isFollowup: true },
      { text: "What does 'that' mean in this context?", isFollowup: true },
      { text: "The first one you mentioned", isFollowup: true },
      { text: "Both of those", isFollowup: true },
      { text: "All of them", isFollowup: true },
    ],
  },
  {
    name: "clarification_reply",
    questions: [
      {
        text: "The error rate specifically",
        replyToClarification: {
          originalQuestion: "Show me the metrics",
          clarificationText: "Which metrics are you interested in?\n1. Error rate\n2. Latency\n3. Throughput",
        },
        clarificationChainLength: 1,
      },
      {
        text: "3",
        replyToClarification: {
          originalQuestion: "What do the logs show?",
          clarificationText: "1. Error logs from web service\n2. Warning logs from database\n3. Both error and warning logs",
        },
        clarificationChainLength: 1,
      },
      {
        text: "I want all of them",
        replyToClarification: {
          originalQuestion: "Which traces?",
          clarificationText: "1. Failed traces\n2. Slow traces\n3. All traces",
        },
        clarificationChainLength: 1,
      },
      {
        text: "もっと具体的に教えて",
        locale: "ja",
        clarificationChainLength: 2,
      },
      {
        text: "Just give me the answer",
        clarificationChainLength: 2,
      },
      {
        text: "whatever, just show me something",
        clarificationChainLength: 3,
      },
      {
        text: "yes",
        replyToClarification: {
          originalQuestion: "Is the latency the main issue?",
          clarificationText: "Do you want me to focus on latency?",
        },
      },
      {
        text: "no",
        replyToClarification: {
          originalQuestion: "Should I look at network?",
          clarificationText: "Shall I focus on network-related evidence?",
        },
      },
      {
        text: "The second option please",
        replyToClarification: {
          originalQuestion: "What aspect?",
          clarificationText: "1. Error analysis\n2. Performance analysis",
        },
      },
      {
        text: "サービス間の依存関係について",
        locale: "ja",
        replyToClarification: {
          originalQuestion: "何を調べたい？",
          clarificationText: "もう少し具体的にお願いします。",
        },
      },
    ],
  },
  {
    name: "meta_speech",
    questions: [
      { text: "just answer me already" },
      { text: "are you broken?" },
      { text: "wtf is wrong with you" },
      { text: "useless" },
      { text: "答えてくれ" },
      { text: "いかれてる" },
      { text: "意味ない" },
      { text: "もういい" },
      { text: "hello" },
      { text: "こんにちは" },
    ],
  },
  {
    name: "japanese",
    questions: [
      { text: "何が起きた？", locale: "ja" },
      { text: "根本原因は何？", locale: "ja" },
      { text: "最初に何をすべき？", locale: "ja" },
      { text: "メトリクスに異常はある？", locale: "ja" },
      { text: "ログには何が書いてある？", locale: "ja" },
      { text: "トレースで失敗パスを見せて", locale: "ja" },
      { text: "影響範囲は？", locale: "ja" },
      { text: "バックオフとは何？", locale: "ja" },
      { text: "レート制限ってなんですか？", locale: "ja" },
      { text: "復旧の見込みは？", locale: "ja" },
    ],
  },
  {
    name: "edge_cases",
    questions: [
      { text: "x".repeat(500) }, // long but within body limit
      { text: "SELECT * FROM incidents; DROP TABLE incidents;--" },
      { text: "<script>alert('xss')</script>" },
      { text: "   " }, // whitespace only - will be trimmed and caught by min(1)
      { text: "a" }, // minimum length
      { text: "What about the 500 error on /api/checkout at 2024-01-01T00:01:00Z?" },
      { text: "Show me trace-1:span-1" },
      { text: "🔥🚨💥" },
      { text: "null" },
      { text: "undefined" },
    ],
  },
  {
    name: "multi_turn",
    questions: [
      { text: "What happened during this incident?" },
      { text: "Which service was affected first?", isFollowup: true },
      { text: "What caused that service to fail?", isFollowup: true },
      { text: "Are there traces showing this?", isFollowup: true },
      { text: "What do the metrics confirm?", isFollowup: true },
      { text: "Do the logs support that analysis?", isFollowup: true },
      { text: "What is the recommended action?", isFollowup: true },
      { text: "Is there anything I should NOT do?", isFollowup: true },
      { text: "What should I monitor after taking action?", isFollowup: true },
      { text: "Summarize the full picture", isFollowup: true },
    ],
  },
  {
    name: "language_switch",
    questions: [
      { text: "What happened?", locale: "en" },
      { text: "もっと詳しく", locale: "ja", isFollowup: true },
      { text: "Which traces show this?", locale: "en", isFollowup: true },
      { text: "メトリクスは？", locale: "ja", isFollowup: true },
      { text: "What should I do?", locale: "en" },
      { text: "それは安全？", locale: "ja", isFollowup: true },
      { text: "Show me the logs", locale: "en" },
      { text: "異常なログクラスタはどれ？", locale: "ja", isFollowup: true },
      { text: "What is the root cause?", locale: "en" },
      { text: "原因の確信度は？", locale: "ja", isFollowup: true },
    ],
  },
];

// ── UX judgment logic ───────────────────────────────────────────────

function judgeUX(
  question: string,
  category: string,
  response: EvidenceQueryResponse,
  responseTimeMs: number,
  replyToClarification?: { originalQuestion: string; clarificationText: string },
  clarificationChainLength?: number,
): { judgment: "PASS" | "FAIL"; reason: string } {
  // Response time check
  if (responseTimeMs > 10_000) {
    return { judgment: "FAIL", reason: `Response time ${responseTimeMs}ms exceeds 10s limit` };
  }

  // Meta-speech should not return clarification
  if (category === "meta_speech") {
    if (response.status === "clarification") {
      return { judgment: "FAIL", reason: "Meta-speech should not trigger clarification" };
    }
    // Greetings should return no_answer with guidance
    if (/^(hi|hello|hey|こんにちは|こんばんは|おはよう)/i.test(question.trim())) {
      if (response.status !== "no_answer") {
        return { judgment: "FAIL", reason: "Greeting should return no_answer" };
      }
      return { judgment: "PASS", reason: "Greeting correctly returns guidance" };
    }
    // Frustration should return no_answer with rephrase suggestion
    if (response.status === "no_answer" && response.noAnswerReason) {
      return { judgment: "PASS", reason: "Frustration correctly handled with fallback" };
    }
    // Or if frustration + pending clarification, should get answered
    if (response.status === "answered") {
      return { judgment: "PASS", reason: "Frustration with context answered the original question" };
    }
    return { judgment: "PASS", reason: "Meta-speech handled" };
  }

  // Answered responses must have at least 1 segment
  if (response.status === "answered" && response.segments.length === 0) {
    return { judgment: "FAIL", reason: "Answered but no segments" };
  }

  // Clarification chain escape: if chainLength >= 2, should not return clarification
  if ((clarificationChainLength ?? 0) >= 2 && response.status === "clarification") {
    return { judgment: "FAIL", reason: "Clarification chain exceeded 2 but still clarifying" };
  }

  // Edge case: whitespace-only should fail at API level (400)
  if (question.trim().length === 0) {
    return { judgment: "PASS", reason: "Empty question handled by API validation" };
  }

  // Clarification is acceptable for first-time ambiguous questions
  if (response.status === "clarification") {
    if (!response.clarificationQuestion) {
      return { judgment: "FAIL", reason: "Clarification without clarificationQuestion text" };
    }
    return { judgment: "PASS", reason: "Appropriate clarification question" };
  }

  // no_answer is acceptable in some cases
  if (response.status === "no_answer") {
    if (!response.noAnswerReason) {
      return { judgment: "FAIL", reason: "no_answer without reason" };
    }
    return { judgment: "PASS", reason: `No answer: ${response.noAnswerReason.slice(0, 80)}` };
  }

  // Answered - check evidence refs exist
  const totalRefs = response.segments.reduce(
    (sum, seg) => sum + seg.evidenceRefs.length,
    0,
  );
  if (totalRefs === 0 && response.segments.length > 0) {
    return { judgment: "FAIL", reason: "Answered but no evidence refs in any segment" };
  }

  return { judgment: "PASS", reason: "Answered with evidence" };
}

// ── Main test runner ────────────────────────────────────────────────

async function runTest(): Promise<void> {
  const results: TurnResult[] = [];
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let turnNumber = 0;

  for (const category of CATEGORIES) {
    // Reset history between categories (except multi_turn)
    if (category.name !== "multi_turn" && category.name !== "language_switch") {
      history.length = 0;
    }

    for (const q of category.questions) {
      turnNumber++;
      const questionText = q.text.trim();

      // Skip empty questions (they'd fail API validation)
      if (questionText.length === 0) {
        results.push({
          turn: turnNumber,
          category: category.name,
          question: "(whitespace only)",
          status: "skipped",
          responseTimeMs: 0,
          segmentCount: 0,
          evidenceRefCount: 0,
          followupCount: 0,
          uxJudgment: "PASS",
          uxReason: "Empty question skipped - caught by API validation",
        });
        continue;
      }

      // Trim history to stay under 4KB body limit: keep last 6 turns max,
      // and truncate long content entries to 200 chars
      const trimmedHistory = history.slice(-6).map((h) => ({
        role: h.role,
        content: h.content.length > 200 ? h.content.slice(0, 200) : h.content,
      }));

      const body: Record<string, unknown> = {
        question: questionText,
        isFollowup: q.isFollowup ?? false,
        history: trimmedHistory,
      };
      if (q.locale) body.locale = q.locale;
      if (q.replyToClarification) body.replyToClarification = q.replyToClarification;
      if (q.clarificationChainLength !== undefined) body.clarificationChainLength = q.clarificationChainLength;

      const startMs = Date.now();
      let response: EvidenceQueryResponse;
      let responseTimeMs: number;

      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;

        const res = await fetch(
          `${RECEIVER_URL}/api/incidents/${encodeURIComponent(INCIDENT_ID)}/evidence/query`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          },
        );
        responseTimeMs = Date.now() - startMs;

        if (!res.ok) {
          const errText = await res.text();
          results.push({
            turn: turnNumber,
            category: category.name,
            question: questionText.slice(0, 100),
            status: `error_${res.status}`,
            responseTimeMs,
            segmentCount: 0,
            evidenceRefCount: 0,
            followupCount: 0,
            uxJudgment: res.status === 400 && questionText.length <= 1 ? "PASS" : "FAIL",
            uxReason: `HTTP ${res.status}: ${errText.slice(0, 200)}`,
          });

          // Don't add errored turns to history
          continue;
        }

        response = (await res.json()) as EvidenceQueryResponse;
      } catch (error) {
        responseTimeMs = Date.now() - startMs;
        results.push({
          turn: turnNumber,
          category: category.name,
          question: questionText.slice(0, 100),
          status: "error_network",
          responseTimeMs,
          segmentCount: 0,
          evidenceRefCount: 0,
          followupCount: 0,
          uxJudgment: "FAIL",
          uxReason: `Network error: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      const totalRefs = response.segments.reduce(
        (sum, seg) => sum + seg.evidenceRefs.length,
        0,
      );

      const { judgment, reason } = judgeUX(
        questionText,
        category.name,
        response,
        responseTimeMs,
        q.replyToClarification,
        q.clarificationChainLength,
      );

      results.push({
        turn: turnNumber,
        category: category.name,
        question: questionText.slice(0, 100),
        status: response.status,
        responseTimeMs,
        segmentCount: response.segments.length,
        evidenceRefCount: totalRefs,
        followupCount: response.followups.length,
        clarificationQuestion: response.clarificationQuestion,
        noAnswerReason: response.noAnswerReason,
        uxJudgment: judgment,
        uxReason: reason,
      });

      // Build history for subsequent turns
      history.push({ role: "user", content: questionText });
      if (response.status === "answered" && response.segments.length > 0) {
        history.push({
          role: "assistant",
          content: response.segments.map((s) => s.text).join(" "),
        });
      } else if (response.clarificationQuestion) {
        history.push({ role: "assistant", content: response.clarificationQuestion });
      } else if (response.noAnswerReason) {
        history.push({ role: "assistant", content: response.noAnswerReason });
      }
    }
  }

  // ── Output ──────────────────────────────────────────────────────────

  // Full results to stdout as JSON
  console.log(JSON.stringify(results, null, 2));

  // Summary to stderr
  const passed = results.filter((r) => r.uxJudgment === "PASS").length;
  const failed = results.filter((r) => r.uxJudgment === "FAIL").length;
  const times = results.filter((r) => r.responseTimeMs > 0).map((r) => r.responseTimeMs);
  const sortedTimes = [...times].sort((a, b) => a - b);
  const avgTime = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  const p95Index = Math.floor(sortedTimes.length * 0.95);
  const p95Time = sortedTimes[p95Index] ?? 0;
  const minTime = sortedTimes[0] ?? 0;
  const maxTime = sortedTimes[sortedTimes.length - 1] ?? 0;

  const byCategory = new Map<string, { pass: number; fail: number; total: number }>();
  for (const r of results) {
    const entry = byCategory.get(r.category) ?? { pass: 0, fail: 0, total: 0 };
    entry.total++;
    if (r.uxJudgment === "PASS") entry.pass++;
    else entry.fail++;
    byCategory.set(r.category, entry);
  }

  const byStatus = new Map<string, number>();
  for (const r of results) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  }

  console.error("\n=== 100-Turn Evidence Query UX Test Summary ===\n");
  console.error(`Total turns: ${results.length}`);
  console.error(`Passed: ${passed} / Failed: ${failed}`);
  console.error(`Pass rate: ${((passed / results.length) * 100).toFixed(1)}%\n`);

  console.error("Response time (ms):");
  console.error(`  Min: ${minTime}`);
  console.error(`  Max: ${maxTime}`);
  console.error(`  Avg: ${avgTime.toFixed(0)}`);
  console.error(`  P95: ${p95Time}`);
  console.error(`  Over 3s: ${times.filter((t) => t > 3000).length}`);
  console.error(`  Over 10s: ${times.filter((t) => t > 10000).length}\n`);

  console.error("By category:");
  for (const [cat, stats] of byCategory.entries()) {
    console.error(`  ${cat}: ${stats.pass}/${stats.total} pass (${stats.fail} fail)`);
  }

  console.error("\nBy status:");
  for (const [status, count] of byStatus.entries()) {
    console.error(`  ${status}: ${count}`);
  }

  if (failed > 0) {
    console.error("\n--- Failed turns ---");
    for (const r of results.filter((r) => r.uxJudgment === "FAIL")) {
      console.error(`  Turn ${r.turn} [${r.category}]: "${r.question.slice(0, 50)}..." -> ${r.uxReason}`);
    }
  }

  console.error("\n=== End Summary ===\n");
}

runTest().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
