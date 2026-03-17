import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiagnosisDebouncer } from "../diagnosis-debouncer.js";

describe("DiagnosisDebouncer", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fires callback when generation threshold is reached", () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 5,
      maxWaitMs: 180_000,
      onReady: cb,
    });
    debouncer.track("inc_1", "pkt_1");
    debouncer.onGenerationUpdate("inc_1", 5);
    expect(cb).toHaveBeenCalledWith("inc_1", "pkt_1");
  });

  it("fires callback on max wait timeout even if generation is low", () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 50,
      maxWaitMs: 10_000,
      onReady: cb,
    });
    debouncer.track("inc_1", "pkt_1");
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalledWith("inc_1", "pkt_1");
  });

  it("does not fire twice (generation wins, timer cancelled)", () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 3,
      maxWaitMs: 60_000,
      onReady: cb,
    });
    debouncer.track("inc_1", "pkt_1");
    debouncer.onGenerationUpdate("inc_1", 3);
    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire twice (timer wins, generation after is no-op)", () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 50,
      maxWaitMs: 5_000,
      onReady: cb,
    });
    debouncer.track("inc_1", "pkt_1");
    vi.advanceTimersByTime(5_000);
    debouncer.onGenerationUpdate("inc_1", 50);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("tracks multiple incidents independently", () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 10,
      maxWaitMs: 60_000,
      onReady: cb,
    });
    debouncer.track("inc_1", "pkt_1");
    debouncer.track("inc_2", "pkt_2");
    debouncer.onGenerationUpdate("inc_1", 10);
    expect(cb).toHaveBeenCalledWith("inc_1", "pkt_1");
    expect(cb).not.toHaveBeenCalledWith("inc_2", "pkt_2");
  });

  it("onGenerationUpdate for untracked incident is no-op", () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 5,
      maxWaitMs: 60_000,
      onReady: cb,
    });
    debouncer.onGenerationUpdate("inc_unknown", 100);
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not fire below threshold", () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 50,
      maxWaitMs: 180_000,
      onReady: cb,
    });
    debouncer.track("inc_1", "pkt_1");
    debouncer.onGenerationUpdate("inc_1", 49);
    expect(cb).not.toHaveBeenCalled();
  });

  it("dispose cancels all timers", () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 50,
      maxWaitMs: 10_000,
      onReady: cb,
    });
    debouncer.track("inc_1", "pkt_1");
    debouncer.dispose();
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("duplicate track is ignored", () => {
    const cb = vi.fn();
    const debouncer = new DiagnosisDebouncer({
      generationThreshold: 50,
      maxWaitMs: 10_000,
      onReady: cb,
    });
    debouncer.track("inc_1", "pkt_1");
    debouncer.track("inc_1", "pkt_1"); // duplicate — should not reset timer
    vi.advanceTimersByTime(10_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
