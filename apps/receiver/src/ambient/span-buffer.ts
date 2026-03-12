import type { BufferedSpan } from './types.js'

const CAPACITY = 1000
const TTL_MS = 300_000 // 5 minutes

export class SpanBuffer {
  private buf: BufferedSpan[] = []

  push(span: BufferedSpan): void {
    if (this.buf.length >= CAPACITY) {
      this.buf.shift()
    }
    this.buf.push(span)
  }

  getAll(now?: number): BufferedSpan[] {
    const t = now ?? Date.now()
    const cutoff = t - TTL_MS
    return this.buf.filter((s) => s.ingestedAt >= cutoff)
  }
}
