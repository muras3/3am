export interface DiagnosisDebouncerOptions {
  /** Fire when packet generation >= this value. */
  generationThreshold: number;
  /** Fire after this many ms from track(), regardless of generation. */
  maxWaitMs: number;
  /** Callback when diagnosis should be dispatched. */
  onReady: (incidentId: string, packetId: string) => void;
}

interface TrackedIncident {
  packetId: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Delays thin event dispatch until either:
 * 1. Packet generation reaches the threshold, or
 * 2. Max wait time elapses from incident creation.
 *
 * In-memory only — suitable for MemoryAdapter (local dev, Phase 1).
 */
export class DiagnosisDebouncer {
  private readonly opts: DiagnosisDebouncerOptions;
  private readonly tracked = new Map<string, TrackedIncident>();

  constructor(opts: DiagnosisDebouncerOptions) {
    this.opts = opts;
  }

  /** Start tracking a newly created incident. */
  track(incidentId: string, packetId: string): void {
    if (this.tracked.has(incidentId)) return;
    const timer = setTimeout(() => this.fire(incidentId), this.opts.maxWaitMs);
    this.tracked.set(incidentId, { packetId, timer });
  }

  /** Called after each rebuildSnapshots — check generation threshold. */
  onGenerationUpdate(incidentId: string, generation: number): void {
    const entry = this.tracked.get(incidentId);
    if (!entry) return;
    if (generation >= this.opts.generationThreshold) {
      this.fire(incidentId);
    }
  }

  /** Cancel all timers (for graceful shutdown / tests). */
  dispose(): void {
    for (const entry of this.tracked.values()) {
      clearTimeout(entry.timer);
    }
    this.tracked.clear();
  }

  private fire(incidentId: string): void {
    const entry = this.tracked.get(incidentId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.tracked.delete(incidentId);
    this.opts.onReady(incidentId, entry.packetId);
  }
}
