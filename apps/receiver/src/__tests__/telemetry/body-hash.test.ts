import { describe, it, expect } from 'vitest'
import { normalizeLogBody, computeBodyHash } from '../../telemetry/body-hash.js'

// ── normalizeLogBody ──────────────────────────────────────────────────────

describe('normalizeLogBody', () => {
  it('replaces UUIDs with <UUID>', () => {
    const body = 'Failed for request 550e8400-e29b-41d4-a716-446655440000'
    expect(normalizeLogBody(body)).toBe('Failed for request <UUID>')
  })

  it('replaces multiple UUIDs', () => {
    const body = 'req=550e8400-e29b-41d4-a716-446655440000 parent=6ba7b810-9dad-11d1-80b4-00c04fd430c8'
    expect(normalizeLogBody(body)).toBe('req=<UUID> parent=<UUID>')
  })

  it('replaces UUIDs case-insensitively', () => {
    const body = 'ID: 550E8400-E29B-41D4-A716-446655440000'
    expect(normalizeLogBody(body)).toBe('ID: <UUID>')
  })

  it('replaces IPv4 addresses with <IP>', () => {
    const body = 'Connection refused to 10.0.1.5:5432'
    expect(normalizeLogBody(body)).toBe('Connection refused to <IP>:<NUM>')
  })

  it('replaces multiple IPs', () => {
    const body = 'From 192.168.1.1 to 10.0.0.1'
    expect(normalizeLogBody(body)).toBe('From <IP> to <IP>')
  })

  it('replaces numbers with <NUM>', () => {
    const body = 'Timeout after 3000ms, retry 5'
    expect(normalizeLogBody(body)).toBe('Timeout after <NUM>ms, retry <NUM>')
  })

  it('replaces floating point numbers', () => {
    const body = 'CPU usage: 95.7%'
    expect(normalizeLogBody(body)).toBe('CPU usage: <NUM>%')
  })

  it('handles mixed replacements', () => {
    const body = 'Request 550e8400-e29b-41d4-a716-446655440000 to 10.0.1.5 failed after 3000ms'
    const result = normalizeLogBody(body)
    expect(result).toBe('Request <UUID> to <IP> failed after <NUM>ms')
  })

  it('returns unchanged body with no variable parts', () => {
    const body = 'Connection refused'
    expect(normalizeLogBody(body)).toBe('Connection refused')
  })

  it('handles empty string', () => {
    expect(normalizeLogBody('')).toBe('')
  })
})

// ── computeBodyHash ───────────────────────────────────────────────────────

describe('computeBodyHash', () => {
  it('produces deterministic output for the same input', async () => {
    const hash1 = await computeBodyHash('Connection refused to 10.0.1.5:5432')
    const hash2 = await computeBodyHash('Connection refused to 10.0.1.5:5432')
    expect(hash1).toBe(hash2)
  })

  it('produces a 16-character hex string', async () => {
    const hash = await computeBodyHash('test body')
    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces same hash for structurally identical messages with different variable parts', async () => {
    const hash1 = await computeBodyHash('Connection refused to 10.0.1.5:5432 after 3000ms')
    const hash2 = await computeBodyHash('Connection refused to 10.0.1.6:5432 after 5000ms')
    expect(hash1).toBe(hash2)
  })

  it('produces same hash for messages differing only in UUID', async () => {
    const hash1 = await computeBodyHash('Failed for request 550e8400-e29b-41d4-a716-446655440000')
    const hash2 = await computeBodyHash('Failed for request 6ba7b810-9dad-11d1-80b4-00c04fd430c8')
    expect(hash1).toBe(hash2)
  })

  it('produces different hashes for structurally different messages', async () => {
    const hash1 = await computeBodyHash('Connection refused')
    const hash2 = await computeBodyHash('Rate limit exceeded')
    expect(hash1).not.toBe(hash2)
  })

  it('handles empty string', async () => {
    const hash = await computeBodyHash('')
    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })
})
