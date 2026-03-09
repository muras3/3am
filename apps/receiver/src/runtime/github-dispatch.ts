import type { ThinEvent } from "@3amoncall/core";

// Dispatches a thin event to GitHub Actions workflow_dispatch.
// All 4 env vars must be set for dispatch to occur.
// Missing vars → warn and skip (graceful for local dev, ADR 0011 / 0021).
// GITHUB_WORKFLOW_REF controls which branch/tag the workflow runs on:
//   - use "develop" for develop-branch verification
//   - use "main" for release (default)
// Dispatch failure is logged but does NOT fail the incident creation response
// (thin event is already persisted; diagnosis can be retried).
export async function dispatchThinEvent(event: ThinEvent): Promise<void> {
  const token = process.env["GITHUB_TOKEN"];
  const owner = process.env["GITHUB_REPO_OWNER"];
  const repo  = process.env["GITHUB_REPO_NAME"];
  const wfId  = process.env["GITHUB_WORKFLOW_ID"];
  const ref   = process.env["GITHUB_WORKFLOW_REF"] ?? "main";

  if (!token || !owner || !repo || !wfId) {
    console.warn(
      "[receiver] GitHub dispatch skipped — GITHUB_TOKEN/REPO_OWNER/REPO_NAME/WORKFLOW_ID not set",
    );
    return;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${wfId}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref,
      inputs: {
        event_id:    event.event_id,
        incident_id: event.incident_id,
        packet_id:   event.packet_id,
      },
    }),
  });

  if (!res.ok) {
    console.error(
      `[receiver] GitHub Actions dispatch failed: ${res.status} ${res.statusText}`,
    );
  }
}
