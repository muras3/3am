import { describe, it, expect } from 'vitest'
import { isRecord, isArray, nanoToMs, getStringAttr } from '../../domain/otlp-utils.js'

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
  })

  it('returns false for arrays (key behavioral difference vs old anomaly-detector version)', () => {
    expect(isRecord([])).toBe(false)
    expect(isRecord([1, 2, 3])).toBe(false)
  })

  it('returns false for null', () => {
    expect(isRecord(null)).toBe(false)
  })

  it('returns false for primitives', () => {
    expect(isRecord('string')).toBe(false)
    expect(isRecord(42)).toBe(false)
    expect(isRecord(true)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })
})

describe('isArray', () => {
  it('returns true for arrays', () => {
    expect(isArray([])).toBe(true)
    expect(isArray([1, 2, 3])).toBe(true)
  })

  it('returns false for non-arrays', () => {
    expect(isArray({})).toBe(false)
    expect(isArray(null)).toBe(false)
    expect(isArray('string')).toBe(false)
  })
})

describe('nanoToMs', () => {
  it('converts nanosecond string to milliseconds', () => {
    expect(nanoToMs('1741392000000000000')).toBe(1741392000000)
  })

  it('converts nanosecond number to milliseconds', () => {
    expect(nanoToMs(1741392000000000000)).toBeCloseTo(1741392000000, -3)
  })

  it('returns null for null', () => {
    expect(nanoToMs(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(nanoToMs(undefined)).toBeNull()
  })

  it('returns null for string "0"', () => {
    expect(nanoToMs('0')).toBeNull()
  })

  it('returns null for number 0', () => {
    expect(nanoToMs(0)).toBeNull()
  })
})

describe('getStringAttr', () => {
  const attrs = [
    { key: 'service.name', value: { stringValue: 'svc-a' } },
    { key: 'deployment.environment.name', value: { stringValue: 'production' } },
    { key: 'http.response.status_code', value: { intValue: 500 } },
  ]

  it('returns the stringValue for a matching key', () => {
    expect(getStringAttr(attrs, 'service.name')).toBe('svc-a')
    expect(getStringAttr(attrs, 'deployment.environment.name')).toBe('production')
  })

  it('returns empty string for unknown key', () => {
    expect(getStringAttr(attrs, 'unknown.key')).toBe('')
  })

  it('returns empty string for non-stringValue attributes (e.g. intValue)', () => {
    expect(getStringAttr(attrs, 'http.response.status_code')).toBe('')
  })

  it('returns empty string for non-array input', () => {
    expect(getStringAttr(null, 'service.name')).toBe('')
    expect(getStringAttr({}, 'service.name')).toBe('')
  })
})
