/**
 * In-memory bridge job queue for Vercel Fluid Compute.
 *
 * On Vercel, WebSocket upgrade is not available and Durable Objects don't exist.
 * Instead, evidence query / chat requests are enqueued in-memory; the CLI bridge
 * polls `GET /api/bridge/jobs` to pick them up, runs the LLM locally, and posts
 * results back via `POST /api/bridge/results/:jobId`.
 *
 * Fluid Compute ensures the same instance handles concurrent requests, so the
 * enqueue and poll requests will see the same in-memory state.
 *
 * If instances diverge (cold start race), the job times out and the console retries.
 */

import type { BridgeRequest, BridgeResponse } from "../transport/ws-bridge.js";

export interface PendingJob {
  jobId: string;
  request: BridgeRequest;
  enqueuedAt: number;
}

interface JobEntry {
  request: BridgeRequest;
  enqueuedAt: number;
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  settled: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TTL_MS = 120_000; // 2 minutes — jobs older than this are discarded
const CLEANUP_INTERVAL_MS = 30_000;

let idCounter = 0;

export class BridgeJobQueue {
  private jobs = new Map<string, JobEntry>();
  private pendingQueue: string[] = []; // FIFO queue of jobIds awaiting pickup
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Unref the timer so it doesn't keep the process alive
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  /** Enqueue a bridge request. Returns the jobId. */
  enqueue(request: BridgeRequest): string {
    const jobId = `bjq_${++idCounter}_${Date.now()}`;
    const entry: JobEntry = {
      request: { ...request, id: jobId },
      enqueuedAt: Date.now(),
      resolve: () => {},
      reject: () => {},
      settled: false,
    };
    this.jobs.set(jobId, entry);
    this.pendingQueue.push(jobId);
    return jobId;
  }

  /** Wait for the result of a specific job. Rejects on timeout. */
  waitForResult(jobId: string, timeoutMs: number): Promise<BridgeResponse> {
    const entry = this.jobs.get(jobId);
    if (!entry) {
      return Promise.reject(new Error(`unknown job: ${jobId}`));
    }

    return new Promise<BridgeResponse>((resolve, reject) => {
      entry.resolve = (response: BridgeResponse) => {
        if (entry.settled) return;
        entry.settled = true;
        if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
        resolve(response);
      };
      entry.reject = (error: Error) => {
        if (entry.settled) return;
        entry.settled = true;
        if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
        reject(error);
      };

      entry.timeoutTimer = setTimeout(() => {
        if (!entry.settled) {
          entry.settled = true;
          this.jobs.delete(jobId);
          reject(new Error(`job ${jobId} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });
  }

  /** Dequeue the next pending job for the bridge to process. Returns null if none. */
  dequeue(): PendingJob | null {
    while (this.pendingQueue.length > 0) {
      const jobId = this.pendingQueue.shift()!;
      const entry = this.jobs.get(jobId);
      if (!entry || entry.settled) continue;

      // Check TTL — skip stale jobs
      if (Date.now() - entry.enqueuedAt > this.ttlMs) {
        entry.reject(new Error(`job ${jobId} expired`));
        this.jobs.delete(jobId);
        continue;
      }

      return {
        jobId,
        request: entry.request,
        enqueuedAt: entry.enqueuedAt,
      };
    }
    return null;
  }

  /** Resolve a pending job with a result from the bridge. */
  resolve(jobId: string, result: BridgeResponse): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry || entry.settled) return false;

    entry.resolve(result);
    this.jobs.delete(jobId);
    return true;
  }

  /** Check if there are any pending jobs. */
  hasPendingJobs(): boolean {
    return this.pendingQueue.some((id) => {
      const entry = this.jobs.get(id);
      return entry && !entry.settled;
    });
  }

  /** Number of active (non-settled) jobs. */
  get size(): number {
    let count = 0;
    for (const entry of this.jobs.values()) {
      if (!entry.settled) count++;
    }
    return count;
  }

  /** Remove stale jobs that have exceeded the TTL. */
  private cleanup(): void {
    const now = Date.now();
    for (const [jobId, entry] of this.jobs) {
      if (now - entry.enqueuedAt > this.ttlMs) {
        if (!entry.settled) {
          entry.reject(new Error(`job ${jobId} expired during cleanup`));
        }
        this.jobs.delete(jobId);
      }
    }
    // Clean up stale entries in pending queue
    this.pendingQueue = this.pendingQueue.filter((id) => this.jobs.has(id));
  }

  /** Stop the cleanup timer. Call when shutting down. */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Reject all pending jobs — entry.reject() handles settled flag + timer cleanup
    for (const [jobId, entry] of this.jobs) {
      if (!entry.settled) {
        entry.reject(new Error(`job queue destroyed`));
      }
      this.jobs.delete(jobId);
    }
    this.pendingQueue = [];
  }
}
