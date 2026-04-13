/**
 * bridge-job-queue.test.ts — Unit tests for BridgeJobQueue.
 */

import { describe, it, expect, afterEach } from "vitest";
import { BridgeJobQueue } from "../bridge-job-queue.js";
import type { BridgeResponse } from "../../transport/ws-bridge.js";

describe("BridgeJobQueue", () => {
  let queue: BridgeJobQueue;

  afterEach(() => {
    queue?.destroy();
  });

  it("enqueue returns a unique jobId", () => {
    queue = new BridgeJobQueue();
    const id1 = queue.enqueue({
      type: "evidence_query_request",
      id: "",
      incidentId: "inc_1",
      receiverUrl: "http://localhost",
      question: "What happened?",
      history: [],
    });
    const id2 = queue.enqueue({
      type: "chat_request",
      id: "",
      incidentId: "inc_1",
      receiverUrl: "http://localhost",
      message: "Hi",
      history: [],
    });
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it("dequeue returns pending jobs in FIFO order", () => {
    queue = new BridgeJobQueue();
    const id1 = queue.enqueue({
      type: "evidence_query_request",
      id: "",
      incidentId: "inc_1",
      receiverUrl: "http://localhost",
      question: "Q1",
      history: [],
    });
    const id2 = queue.enqueue({
      type: "evidence_query_request",
      id: "",
      incidentId: "inc_2",
      receiverUrl: "http://localhost",
      question: "Q2",
      history: [],
    });

    const job1 = queue.dequeue();
    expect(job1).not.toBeNull();
    expect(job1!.jobId).toBe(id1);
    expect(job1!.request.type).toBe("evidence_query_request");

    const job2 = queue.dequeue();
    expect(job2).not.toBeNull();
    expect(job2!.jobId).toBe(id2);

    const job3 = queue.dequeue();
    expect(job3).toBeNull();
  });

  it("waitForResult resolves when resolve is called", async () => {
    queue = new BridgeJobQueue();
    const jobId = queue.enqueue({
      type: "evidence_query_request",
      id: "",
      incidentId: "inc_1",
      receiverUrl: "http://localhost",
      question: "Q",
      history: [],
    });

    const resultPromise = queue.waitForResult(jobId, 5_000);

    const response: BridgeResponse = {
      type: "evidence_query_response",
      id: jobId,
      result: { question: "Q", status: "answered", segments: [] },
    };
    queue.resolve(jobId, response);

    const result = await resultPromise;
    expect(result.type).toBe("evidence_query_response");
    expect(result.id).toBe(jobId);
  });

  it("waitForResult rejects on timeout", async () => {
    queue = new BridgeJobQueue();
    const jobId = queue.enqueue({
      type: "evidence_query_request",
      id: "",
      incidentId: "inc_1",
      receiverUrl: "http://localhost",
      question: "Q",
      history: [],
    });

    await expect(queue.waitForResult(jobId, 50)).rejects.toThrow(/timed out/);
  });

  it("waitForResult rejects for unknown jobId", async () => {
    queue = new BridgeJobQueue();
    await expect(queue.waitForResult("nonexistent", 100)).rejects.toThrow(
      /unknown job/,
    );
  });

  it("resolve returns false for unknown or already-resolved job", () => {
    queue = new BridgeJobQueue();
    const jobId = queue.enqueue({
      type: "chat_request",
      id: "",
      incidentId: "inc_1",
      receiverUrl: "http://localhost",
      message: "Hi",
      history: [],
    });

    const response: BridgeResponse = {
      type: "chat_response",
      id: jobId,
      reply: "Hello",
    };

    expect(queue.resolve("nonexistent", response)).toBe(false);
    expect(queue.resolve(jobId, response)).toBe(true);
    // Second resolve should fail — already settled
    expect(queue.resolve(jobId, response)).toBe(false);
  });

  it("dequeue skips stale jobs that have exceeded TTL", async () => {
    queue = new BridgeJobQueue(50); // 50ms TTL
    queue.enqueue({
      type: "evidence_query_request",
      id: "",
      incidentId: "inc_1",
      receiverUrl: "http://localhost",
      question: "Q",
      history: [],
    });

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 80));

    const job = queue.dequeue();
    expect(job).toBeNull();
  });

  it("size tracks active jobs", () => {
    queue = new BridgeJobQueue();
    expect(queue.size).toBe(0);

    const id1 = queue.enqueue({
      type: "chat_request",
      id: "",
      incidentId: "inc_1",
      receiverUrl: "http://localhost",
      message: "Hi",
      history: [],
    });
    expect(queue.size).toBe(1);

    queue.enqueue({
      type: "chat_request",
      id: "",
      incidentId: "inc_2",
      receiverUrl: "http://localhost",
      message: "Hello",
      history: [],
    });
    expect(queue.size).toBe(2);

    queue.resolve(id1, { type: "chat_response", id: id1, reply: "Hi" });
    expect(queue.size).toBe(1);
  });

  it("destroy rejects all pending jobs", async () => {
    queue = new BridgeJobQueue();
    const jobId = queue.enqueue({
      type: "evidence_query_request",
      id: "",
      incidentId: "inc_1",
      receiverUrl: "http://localhost",
      question: "Q",
      history: [],
    });

    const resultPromise = queue.waitForResult(jobId, 5_000);
    queue.destroy();

    await expect(resultPromise).rejects.toThrow(/destroyed/);
  });

  it("hasPendingJobs reflects queue state", () => {
    queue = new BridgeJobQueue();
    expect(queue.hasPendingJobs()).toBe(false);

    const id = queue.enqueue({
      type: "chat_request",
      id: "",
      incidentId: "inc_1",
      receiverUrl: "http://localhost",
      message: "Hi",
      history: [],
    });
    expect(queue.hasPendingJobs()).toBe(true);

    queue.dequeue();
    // After dequeue the job is still active (just processing, not settled)
    // But it's removed from the pending queue array
    expect(queue.hasPendingJobs()).toBe(false);

    // Resolving the job
    queue.resolve(id, { type: "chat_response", id, reply: "ok" });
    expect(queue.hasPendingJobs()).toBe(false);
  });

  it("enqueue sets the jobId on the request", () => {
    queue = new BridgeJobQueue();
    queue.enqueue({
      type: "evidence_query_request",
      id: "",
      incidentId: "inc_1",
      receiverUrl: "http://localhost",
      question: "Q",
      history: [],
    });

    const job = queue.dequeue();
    expect(job).not.toBeNull();
    expect(job!.request.id).toBe(job!.jobId);
  });

  it("concurrent enqueue and resolve work correctly", async () => {
    queue = new BridgeJobQueue();

    const results = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        const jobId = queue.enqueue({
          type: "evidence_query_request",
          id: "",
          incidentId: `inc_${i}`,
          receiverUrl: "http://localhost",
          question: `Q${i}`,
          history: [],
        });

        const promise = queue.waitForResult(jobId, 5_000);

        // Simulate bridge processing
        const job = queue.dequeue();
        if (job) {
          queue.resolve(job.jobId, {
            type: "evidence_query_response",
            id: job.jobId,
            result: { answer: `A${i}` },
          });
        }

        return promise;
      }),
    );

    expect(results).toHaveLength(5);
    results.forEach((r) => {
      expect(r.type).toBe("evidence_query_response");
    });
  });
});
