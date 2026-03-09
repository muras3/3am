import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatchThinEvent } from "../github-dispatch.js";
import type { ThinEvent } from "@3amoncall/core";

const event: ThinEvent = {
  event_id: "evt_test",
  event_type: "incident.created",
  incident_id: "inc_test",
  packet_id: "pkt_test",
};

describe("dispatchThinEvent", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({ ok: true, status: 204, statusText: "No Content" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_REPO_OWNER"];
    delete process.env["GITHUB_REPO_NAME"];
    delete process.env["GITHUB_WORKFLOW_ID"];
    delete process.env["GITHUB_WORKFLOW_REF"];
  });

  it("skips dispatch when GITHUB_TOKEN is not set", async () => {
    // No env vars set
    await dispatchThinEvent(event);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips dispatch when any required env var is missing", async () => {
    process.env["GITHUB_TOKEN"] = "ghp_test";
    // Missing GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_WORKFLOW_ID
    await dispatchThinEvent(event);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dispatches to correct GitHub API URL when all env vars are set", async () => {
    process.env["GITHUB_TOKEN"]      = "ghp_test";
    process.env["GITHUB_REPO_OWNER"] = "muras3";
    process.env["GITHUB_REPO_NAME"]  = "3amoncall";
    process.env["GITHUB_WORKFLOW_ID"] = "diagnose.yml";

    await dispatchThinEvent(event);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/repos/muras3/3amoncall/actions/workflows/diagnose.yml/dispatches",
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      ref: "main",
      inputs: { event_id: "evt_test", incident_id: "inc_test", packet_id: "pkt_test" },
    });
  });

  it("uses GITHUB_WORKFLOW_REF env var when set", async () => {
    process.env["GITHUB_TOKEN"]       = "ghp_test";
    process.env["GITHUB_REPO_OWNER"]  = "muras3";
    process.env["GITHUB_REPO_NAME"]   = "3amoncall";
    process.env["GITHUB_WORKFLOW_ID"] = "diagnose.yml";
    process.env["GITHUB_WORKFLOW_REF"] = "develop";

    await dispatchThinEvent(event);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).ref).toBe("develop");
  });

  it("does not throw when dispatch fails (non-ok response)", async () => {
    process.env["GITHUB_TOKEN"]       = "ghp_test";
    process.env["GITHUB_REPO_OWNER"]  = "muras3";
    process.env["GITHUB_REPO_NAME"]   = "3amoncall";
    process.env["GITHUB_WORKFLOW_ID"] = "diagnose.yml";
    fetchMock.mockResolvedValue({ ok: false, status: 422, statusText: "Unprocessable Entity" });

    // Should not throw — dispatch failure doesn't fail incident creation
    await expect(dispatchThinEvent(event)).resolves.toBeUndefined();
  });
});
