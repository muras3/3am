#!/usr/bin/env python3
"""Run LLM diagnosis on a fixture or validation run directory.

Adapted from probe-investigate/scripts/run_diagnosis.py.
Differences:
- Loads scenario.probe.json (3am format) first, falls back to scenario.json
- Saves diagnosis.json directly into the run directory (not bench/results/)
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import anthropic
except ImportError:
    print("Install anthropic SDK: pip install anthropic", file=sys.stderr)
    sys.exit(1)


def load_fixture(fixture_dir: Path) -> dict:
    """Load all fixture files from a directory.

    Prefers scenario.probe.json (3am output) over scenario.json.
    """
    for name in ("scenario.probe.json", "scenario.json"):
        scenario_path = fixture_dir / name
        if scenario_path.exists():
            scenario = json.loads(scenario_path.read_text())
            break
    else:
        raise FileNotFoundError(
            f"No scenario.probe.json or scenario.json found in {fixture_dir}"
        )

    inputs = {}
    for inp in scenario["inputs"]:
        for p in inp["paths"]:
            data = json.loads((fixture_dir / p).read_text())
            inputs[inp["type"]] = data
    return {"scenario": scenario, "inputs": inputs}


def build_prompt_v2(fixture: dict) -> str:
    """Build v2 diagnosis prompt (trigger-focused)."""
    parts = [
        "You are an expert SRE performing incident triage at 3am. A pager fired. Analyze the observability data below and diagnose the root cause.",
        "",
        "## Rules",
        "1. **Find the TRIGGER, not the symptom.** If A caused B which caused C, the root cause is A — not B or C. Trace the causal chain to its origin.",
        "2. **Be decisive.** If the data supports a conclusion, state it as fact. Do not hedge with 'possibly' or 'might be'. Say what happened.",
        "3. **Correlate across sources.** No single data source tells the full story. Cross-reference traces, logs, metrics, and platform logs to build the timeline.",
        "4. **Be concise.** A 3am engineer needs to know: what broke, why, and what to do — in under 30 seconds of reading.",
        "5. **Name specifics.** Use exact metric names, values, thresholds, timestamps, and component names from the data. Never generalize when you can be precise.",
        "",
        "## Output Format (strict JSON)",
        "{",
        '  "primary_root_cause": "One sentence. The triggering event, not a downstream effect.",',
        '  "causal_chain": ["Step 1: trigger", "Step 2: ...", "Step 3: visible failure"],',
        '  "confidence": "high|medium|low",',
        '  "evidence": ["Specific data points with values/timestamps that support each step of the causal chain"],',
        '  "recommended_actions": ["Max 3-4 actions, ordered by priority. First action = immediate fix."],',
        '  "additional_hypotheses": ["Max 1-2. Only if genuinely plausible given the data."]',
        "}",
        "",
    ]

    for input_type, data in fixture["inputs"].items():
        parts.append(f"## {input_type}")
        parts.append("```json")
        parts.append(json.dumps(data, indent=2))
        parts.append("```")
        parts.append("")

    return "\n".join(parts)


def build_prompt_v5(fixture: dict) -> str:
    """Build v5 diagnosis prompt (SRE 7-step: quantify, map resources, trace errors, controllability)."""
    parts = [
        "You are the on-call SRE. It's 3am. A pager fired. Your job is NOT to write a postmortem — it's to restore service. Think like you're SSHed into prod.",
        "",
        "## Investigation Process",
        "",
        "Work through these steps. Show your reasoning for each.",
        "",
        "### Step 1: Triage",
        "- What is broken? Who is affected?",
        "- When did it start? Is it getting worse, stable, or recovering?",
        "- How severe is this? (page-worthy / can wait until morning / self-healing)",
        "",
        "### Step 2: Quantify Changes",
        "Rate each dimension 0-100 (0=no change, 100=massive change):",
        "- Deployments / config changes: ___",
        "- Traffic volume or pattern: ___",
        "- External dependencies (APIs, DNS, certs, cloud): ___",
        "- Internal resource usage (CPU, memory, connections, pools): ___",
        "- Scheduled jobs or migrations: ___",
        "A score of 0 is valuable — it rules out that dimension.",
        "High scores are your leads. Multiple high scores suggest a chain reaction — find which came first.",
        "",
        "### Step 3: Map Dependencies and Shared Resources",
        "Before forming hypotheses, map the system:",
        "- **External dependencies**: What upstream services/APIs does the system call? Are any returning errors or slow?",
        "- **Internal dependencies**: What components depend on what?",
        "- **Shared resources**: What resources do multiple components share? (worker pools, thread pools, connection pools, CPU, memory, queues, etc.)",
        "- **Source vs Victim**: Which component FIRST showed errors? Follow the dependency chain UPSTREAM.",
        "",
        "List every shared resource you find. This is critical for later steps — if two 'unrelated' components share a resource, a failure in one CAN cause failure in the other via resource exhaustion.",
        "",
        "### Step 4: Trace Error Responses",
        "For each error or anomaly found so far:",
        "- What triggered this error? (external event, internal bug, resource limit?)",
        "- How does the system RESPOND to this error? Look for retries, fallbacks, queuing, or cascading calls in the traces/logs.",
        "- Does that response consume shared resources (from Step 3) or amplify the problem?",
        "An error is often not the cause itself — the system's REACTION to the error may be what turns a minor issue into a major outage.",
        "",
        "### Step 5: Form and Test Hypotheses",
        "- List at least 3 candidate causes based on Steps 1-4.",
        "- For each, find ONE piece of data that would DISPROVE it.",
        "- When evaluating disproof: 'component X also broke but doesn't use Y' is ONLY valid if X and Y share NO resources from Step 3. If they share a pool/queue/capacity, X breaking is EXPECTED in a cascade — it confirms the hypothesis, not disproves it.",
        "- Eliminate hypotheses that the data contradicts.",
        "- If a hypothesis survives and explains the timeline, it's your lead.",
        "",
        "**Caution — observed trends vs root causes:**",
        '  A trend ("traffic increased", "error rate spiked") is what you SEE.',
        "  A root cause is WHY it happened (a specific code path, config, or design flaw).",
        "  If your cause sounds like a metric description, you haven't gone deep enough.",
        "",
        "### Step 6: Determine Recovery Action",
        "For the surviving hypothesis, answer:",
        "- Can I fix this RIGHT NOW? (rollback, restart, config change, manual override)",
        "- What is the MINIMUM action to restore service?",
        "- What should I NOT do? (actions that would make it worse)",
        "- VERIFY: Does your recovery action DIRECTLY address your diagnosed cause?",
        '  If cause is "retry storm" but fix is "restart service" — restarting won\'t stop the storm. Find the right fix.',
        "",
        "### Step 7: Verify Your Reasoning",
        '- Counterfactual: "If I remove this cause, would the incident still happen?"',
        "  If YES → you have a contributing factor, not the cause. Go deeper.",
        "  If NO → this is your primary cause.",
        "- Controllability test: Is your root cause an external event (traffic spike, API error, user behavior)?",
        "  If yes, it's the TRIGGER, not the root cause. Go back to Step 4 (error responses):",
        "  did any system reaction amplify the problem? If yes, that reaction's DESIGN is the root cause.",
        "  External triggers are inevitable — the root cause is the internal flaw that made the system fragile.",
        "- Does your recovery action match your cause? If cause is X but fix is",
        '  "restart everything" — you haven\'t found the real cause.',
        "",
        "## Output",
        "",
        "Output ONLY a single JSON object. No markdown, no explanation, no text before or after.",
        "",
        "{",
        '  "investigation_log": {',
        '    "triage": "What is broken, since when, severity assessment",',
        '    "change_scores": {"deployments": 0, "traffic": 0, "external_deps": 0, "internal_resources": 0, "scheduled_jobs": 0},',
        '    "change_analysis": "Which dimensions scored high, which scored 0, and what that tells you",',
        '    "shared_resources": ["List every shared resource identified in Step 3"],',
        '    "source_vs_victims": "Which component failed first (source) and which are downstream victims",',
        '    "error_responses": [{"error": "...", "system_reaction": "...", "resource_impact": "..."}],',
        '    "hypotheses": [',
        "      {",
        '        "hypothesis": "...",',
        '        "supporting_evidence": ["..."],',
        '        "disproving_evidence": ["... (only valid if not explained by shared resource cascade)"],',
        '        "verdict": "eliminated|survived"',
        "      }",
        "    ],",
        '    "counterfactual": "If [cause] were absent, would incident occur? → Yes/No"',
        "  },",
        '  "severity": "critical|high|medium|low",',
        '  "impact_scope": "Who/what is affected, quantified if possible",',
        '  "recovery_action": {',
        '    "immediate": "The ONE thing to do right now to restore service",',
        '    "follow_up": ["1-2 additional steps after immediate fix"],',
        '    "do_not": "Action that would make things worse (if applicable)"',
        "  },",
        '  "trigger": "The external event that started the incident (if any)",',
        '  "root_cause": "The internal design flaw or misconfiguration that made the system fragile to the trigger",',
        '  "causal_chain": ["Step 1 → Step 2 → ... → visible failure"]',
        "}",
        "",
    ]

    for input_type, data in fixture["inputs"].items():
        parts.append(f"## {input_type}")
        parts.append("```json")
        parts.append(json.dumps(data, indent=2))
        parts.append("```")
        parts.append("")

    return "\n".join(parts)


def build_prompt_v4_recovery(fixture: dict) -> str:
    """Build v4 recovery prompt (SRE recovery-focused)."""
    parts = [
        "You are the on-call SRE. It's 3am. A pager fired. Your ONLY job right now is to restore service. You are NOT writing a postmortem.",
        "",
        "## Investigation Process",
        "",
        "Work through these steps. Show your reasoning for each.",
        "",
        "### Step 1: Triage",
        "- What is broken? Who is affected?",
        "- When did it start? Is it getting worse, stable, or recovering?",
        "- How severe is this? (page-worthy / can wait until morning / self-healing)",
        "",
        "### Step 2: What Changed?",
        "Check for changes right before symptoms started:",
        "- Recent deployments or config changes",
        "- Traffic pattern shifts",
        "- External dependency changes (APIs, DNS, certs, cloud provider)",
        "- Scheduled jobs or migrations",
        "If nothing changed, focus on resource exhaustion or gradual degradation patterns instead.",
        "",
        "### Step 3: Narrow the Blast Radius",
        "- Which component is the SOURCE vs which are VICTIMS?",
        "- Follow the dependency chain UPSTREAM, not downstream.",
        "- If service A calls service B and both are failing, check B first.",
        "",
        "### Step 4: Determine Recovery Action",
        "Based on Steps 1-3, answer:",
        "- Can I fix this RIGHT NOW? (rollback, restart, config change, flush cache, kill job, manual override)",
        "- What is the MINIMUM action to restore service?",
        "- What should I NOT do? (actions that would make it worse or waste time)",
        "",
        "## Output (strict JSON)",
        "",
        "{",
        '  "investigation_log": {',
        '    "triage": "What is broken, since when, severity assessment",',
        '    "changes_found": ["List of relevant changes near incident start, or NONE if no changes detected"],',
        '    "blast_radius": "Source component vs victims"',
        "  },",
        '  "severity": "critical|high|medium|low",',
        '  "impact_scope": "Who/what is affected, quantified if possible",',
        '  "recovery_action": {',
        '    "immediate": "The ONE thing to do right now to restore service",',
        '    "follow_up": ["1-2 additional steps after immediate fix"],',
        '    "do_not": "Action that would make things worse (if applicable)"',
        "  }",
        "}",
        "",
    ]

    for input_type, data in fixture["inputs"].items():
        parts.append(f"## {input_type}")
        parts.append("```json")
        parts.append(json.dumps(data, indent=2))
        parts.append("```")
        parts.append("")

    return "\n".join(parts)


def build_prompt_v4_rootcause(fixture: dict) -> str:
    """Build v4 root cause prompt (structured hypothesis testing)."""
    parts = [
        "You are an expert SRE investigating a production incident. Your job is to find the ROOT CAUSE — not symptoms, not downstream effects.",
        "",
        "## Investigation Process",
        "",
        "Work through these steps. Show your reasoning for each.",
        "",
        "### Step 1: Build Timeline",
        "- When did the first anomaly appear? Use exact timestamps from the data.",
        "- What is the sequence of events across all data sources?",
        "",
        "### Step 2: What Changed?",
        "Check for changes right before symptoms started:",
        "- Recent deployments or config changes",
        "- Traffic pattern shifts",
        "- External dependency changes (APIs, DNS, certs, cloud provider)",
        "- Scheduled jobs or migrations",
        "- Resource limits being hit (memory, connections, rate limits)",
        "If nothing external changed, look for gradual internal degradation.",
        "",
        "### Step 3: Narrow the Blast Radius",
        "- Which component is the SOURCE vs which are VICTIMS?",
        "- Follow the dependency chain UPSTREAM, not downstream.",
        "- If service A calls service B and both are failing, check B first.",
        "",
        "### Step 4: Form and Test Hypotheses",
        "- List at least 3 candidate causes based on Steps 1-3.",
        "- For each, find ONE piece of data that would DISPROVE it.",
        "- Eliminate hypotheses that the data contradicts.",
        "- IMPORTANT: If your evidence section mentions a cause, do NOT relegate it to a secondary hypothesis. If the data points to it, it is your primary candidate.",
        "",
        "### Step 5: Drill Down (5 Whys)",
        "For the surviving hypothesis, ask WHY repeatedly:",
        "- Don't stop at WHAT is broken. Find the MECHANISM — the specific code path, config, resource, or interaction that caused it.",
        "- Example: 'Memory leak' is WHAT. 'WebSocket resume handler not cleaning up previous session state on reconnect' is WHY.",
        "",
        "### Step 6: Counterfactual Verification",
        '- "If I remove this cause, would the incident still happen?"',
        "  If YES → you have a contributing factor, not the cause. Go deeper.",
        "  If NO → this is your primary cause.",
        "- If multiple factors are needed: the one whose removal PREVENTS the incident is primary. The one that merely AMPLIFIES it is secondary.",
        "",
        "## Output (strict JSON)",
        "",
        "{",
        '  "investigation_log": {',
        '    "timeline": "First anomaly timestamp and sequence of events",',
        '    "changes_found": ["List of relevant changes, or NONE"],',
        '    "blast_radius": "Source component vs victims",',
        '    "hypotheses": [',
        "      {",
        '        "hypothesis": "...",',
        '        "supporting_evidence": ["..."],',
        '        "disproving_evidence": ["..."],',
        '        "verdict": "eliminated|survived"',
        "      }",
        "    ],",
        '    "five_whys": ["Why 1: ...", "Why 2: ...", "Why 3: ..."],',
        '    "counterfactual": "If [cause] were absent, would incident occur? → Yes/No"',
        "  },",
        '  "primary_root_cause": "One sentence. The triggering event AND its mechanism.",',
        '  "causal_chain": ["Step 1: trigger", "Step 2: ...", "Step 3: visible failure"],',
        '  "confidence": "high|medium|low",',
        '  "evidence": ["Specific data points with values/timestamps supporting each step"]',
        "}",
        "",
    ]

    for input_type, data in fixture["inputs"].items():
        parts.append(f"## {input_type}")
        parts.append("```json")
        parts.append(json.dumps(data, indent=2))
        parts.append("```")
        parts.append("")

    return "\n".join(parts)


PROMPT_BUILDERS = {
    "v2": build_prompt_v2,
    "v5": build_prompt_v5,
    "v4-recovery": build_prompt_v4_recovery,
    "v4-rootcause": build_prompt_v4_rootcause,
}


def build_prompt(fixture: dict, version: str = "v2") -> str:
    """Build diagnosis prompt using the specified version."""
    builder = PROMPT_BUILDERS.get(version)
    if not builder:
        raise ValueError(f"Unknown prompt version: {version}. Available: {list(PROMPT_BUILDERS.keys())}")
    return builder(fixture)


def _call_llm(client, model: str, prompt: str, max_tokens: int) -> dict:
    """Call LLM and parse JSON response."""
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        temperature=0,
        messages=[{"role": "user", "content": prompt}],
    )
    raw_text = response.content[0].text
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        match = re.search(r"```(?:json)?\s*\n(.*?)\n```", raw_text, re.DOTALL)
        if match:
            return json.loads(match.group(1))
        return {"raw_response": raw_text, "parse_error": "Could not parse JSON"}


def run_diagnosis(fixture_dir: Path, model: str = "claude-sonnet-4-6", prompt_version: str = "v2") -> dict:
    """Run LLM diagnosis on fixture data."""
    import time
    from concurrent.futures import ThreadPoolExecutor

    fixture = load_fixture(fixture_dir)
    client = anthropic.Anthropic()
    t_start = time.monotonic()

    if prompt_version == "v4":
        prompt_r = build_prompt(fixture, "v4-recovery")
        prompt_c = build_prompt(fixture, "v4-rootcause")

        with ThreadPoolExecutor(max_workers=2) as pool:
            future_r = pool.submit(_call_llm, client, model, prompt_r, 4096)
            future_c = pool.submit(_call_llm, client, model, prompt_c, 8192)
            recovery_result = future_r.result()
            rootcause_result = future_c.result()

        t_elapsed = time.monotonic() - t_start

        diagnosis = {
            "recovery": recovery_result,
            "rootcause": rootcause_result,
            "merged": {
                "severity": recovery_result.get("severity"),
                "impact_scope": recovery_result.get("impact_scope"),
                "recovery_action": recovery_result.get("recovery_action"),
                "primary_root_cause": rootcause_result.get("primary_root_cause"),
                "causal_chain": rootcause_result.get("causal_chain"),
                "confidence": rootcause_result.get("confidence"),
                "evidence": rootcause_result.get("evidence"),
            },
        }
        prompt_length = len(prompt_r) + len(prompt_c)
    else:
        prompt = build_prompt(fixture, prompt_version)
        max_tokens = 4096 if prompt_version == "v2" else 8192
        diagnosis = _call_llm(client, model, prompt, max_tokens)
        t_elapsed = time.monotonic() - t_start
        prompt_length = len(prompt)

    return {
        "fixture_id": fixture["scenario"]["id"],
        "model": model,
        "prompt_version": prompt_version,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "ground_truth": fixture["scenario"]["ground_truth"],
        "diagnosis": diagnosis,
        "prompt_length_chars": prompt_length,
        "elapsed_seconds": round(t_elapsed, 1),
    }


def main():
    parser = argparse.ArgumentParser(description="Run LLM diagnosis on a fixture or validation run directory")
    parser.add_argument("fixture_dir", type=Path, help="Path to fixture/run directory")
    parser.add_argument("--model", default="claude-sonnet-4-6", help="Model to use")
    parser.add_argument("--prompt", default="v2", choices=list(PROMPT_BUILDERS.keys()) + ["v4"], help="Prompt version")
    parser.add_argument("--output", type=Path, default=None, help="Output file path (default: <fixture_dir>/diagnosis.json)")
    args = parser.parse_args()

    if not args.fixture_dir.exists():
        print(f"Error: {args.fixture_dir} does not exist", file=sys.stderr)
        sys.exit(1)

    result = run_diagnosis(args.fixture_dir, args.model, args.prompt)

    output = json.dumps(result, indent=2, ensure_ascii=False)
    print(output)

    out_path = args.output if args.output else args.fixture_dir / "diagnosis.json"
    out_path.write_text(output)
    print(f"Saved to {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
