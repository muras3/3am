import { describe, it, expect } from 'vitest'
import {
  isRecord,
  isArray,
  nanoToMs,
  getStringAttr,
  resolveResourceServiceName,
  resolveResourceEnvironment,
  resolveEffectiveBody,
} from '../../domain/otlp-utils.js'

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

describe('resolveResourceServiceName', () => {
  it('prefers service.name when present', () => {
    const attrs = [{ key: 'service.name', value: { stringValue: 'svc-a' } }]
    expect(resolveResourceServiceName(attrs)).toBe('svc-a')
  })

  it('falls back to CF Workers faas.name and cloudflare.script_name', () => {
    expect(resolveResourceServiceName([{ key: 'faas.name', value: { stringValue: 'worker-a' } }])).toBe('worker-a')
    expect(resolveResourceServiceName([{ key: 'cloudflare.script_name', value: { stringValue: 'worker-b' } }])).toBe('worker-b')
  })

  it('skips CF dummy service.name and falls back to faas.name', () => {
    const attrs = [
      { key: 'service.name', value: { stringValue: 'cloudflare-workers-observability' } },
      { key: 'faas.name', value: { stringValue: 'my-worker' } },
    ]
    expect(resolveResourceServiceName(attrs)).toBe('my-worker')
  })

  it('returns CF dummy service.name when no alternatives exist', () => {
    const attrs = [
      { key: 'service.name', value: { stringValue: 'cloudflare-workers-observability' } },
    ]
    expect(resolveResourceServiceName(attrs)).toBe('cloudflare-workers-observability')
  })

  it('defaults to unknown when no resource service attribute is present', () => {
    expect(resolveResourceServiceName([])).toBe('unknown')
  })
})

describe('resolveResourceEnvironment', () => {
  it('prefers deployment.environment.name when present', () => {
    const attrs = [{ key: 'deployment.environment.name', value: { stringValue: 'staging' } }]
    expect(resolveResourceEnvironment(attrs)).toBe('staging')
  })

  it('falls back to cloudflare.environment', () => {
    const attrs = [{ key: 'cloudflare.environment', value: { stringValue: 'preview' } }]
    expect(resolveResourceEnvironment(attrs)).toBe('preview')
  })

  it('defaults to production when no resource environment attribute is present', () => {
    expect(resolveResourceEnvironment([])).toBe('production')
  })
})

describe('resolveEffectiveBody', () => {
  // ── Non-trivial body → returned as-is ──────────────────────────────────

  it('returns non-empty body unchanged', () => {
    const attrs = { event: { stringValue: 'order.created' } }
    expect(resolveEffectiveBody('checkout failed', attrs)).toBe('checkout failed')
  })

  it('returns body with whitespace unchanged (non-trivial content)', () => {
    const attrs = { event: { stringValue: 'ignored' } }
    expect(resolveEffectiveBody('  hello  ', attrs)).toBe('  hello  ')
  })

  it('returns non-trivial body even when attributes are empty', () => {
    expect(resolveEffectiveBody('something happened', {})).toBe('something happened')
  })

  // ── Empty body → synthesise from attributes ────────────────────────────

  it('synthesises body from string attributes when body is empty string', () => {
    const attrs = {
      event: { stringValue: 'order.created' },
      'order_id': { stringValue: 'ord_123' },
    }
    const result = resolveEffectiveBody('', attrs)
    const parsed = JSON.parse(result) as Record<string, unknown>
    expect(parsed['event']).toBe('order.created')
    expect(parsed['order_id']).toBe('ord_123')
  })

  it('synthesises body from mixed-type attributes when body is empty', () => {
    const attrs = {
      event: { stringValue: 'payment.failed' },
      amount: { intValue: 500 },
      retried: { boolValue: true },
    }
    const result = resolveEffectiveBody('', attrs)
    const parsed = JSON.parse(result) as Record<string, unknown>
    expect(parsed['event']).toBe('payment.failed')
    expect(parsed['amount']).toBe(500)
    expect(parsed['retried']).toBe(true)
  })

  it('synthesises body from attributes when body is "{}"', () => {
    const attrs = { event: { stringValue: 'stripe.rate_limit' } }
    const result = resolveEffectiveBody('{}', attrs)
    const parsed = JSON.parse(result) as Record<string, unknown>
    expect(parsed['event']).toBe('stripe.rate_limit')
  })

  it('synthesises body from attributes when body is \'"\\"\\""\' (CF body:null → JSON-encoded empty string)', () => {
    // CF Workers sends body:null; extractor does JSON.stringify(null ?? '') = '""'
    // This '""' must be treated as trivial and synthesised from attributes (#326)
    const attrs = { event: { stringValue: 'payment_failed' }, level: { stringValue: 'error' } }
    const result = resolveEffectiveBody('""', attrs)
    const parsed = JSON.parse(result) as Record<string, unknown>
    expect(parsed['event']).toBe('payment_failed')
    expect(parsed['level']).toBe('error')
  })

  it('synthesises body from attributes when body is "{}" with surrounding whitespace', () => {
    const attrs = { event: { stringValue: 'test' } }
    const result = resolveEffectiveBody('  {}  ', attrs)
    const parsed = JSON.parse(result) as Record<string, unknown>
    expect(parsed['event']).toBe('test')
  })

  // ── Empty/trivial body with no usable attributes ─────────────────────

  it('returns empty string unchanged when no attributes are present', () => {
    expect(resolveEffectiveBody('', {})).toBe('')
  })

  it('returns "{}" unchanged when attributes have no scalar values', () => {
    // Complex OTLP values (kvlistValue, arrayValue) are not synthesised
    const attrs = {
      tags: { kvlistValue: { values: [] } },
    }
    expect(resolveEffectiveBody('{}', attrs)).toBe('{}')
  })

  it('skips non-OTLP-AnyValue attribute entries in synthesis', () => {
    // Attributes that are plain strings (not OTLP wrappers) are ignored
    const attrs = {
      event: 'order.created',  // not wrapped in {stringValue: ...}
    }
    expect(resolveEffectiveBody('', attrs)).toBe('')
  })

  // ── doubleValue support ──────────────────────────────────────────────

  it('synthesises body from doubleValue attributes', () => {
    const attrs = { ratio: { doubleValue: 0.75 } }
    const result = resolveEffectiveBody('', attrs)
    const parsed = JSON.parse(result) as Record<string, unknown>
    expect(parsed['ratio']).toBe(0.75)
  })

  // ── intValue as string (protobuf transport) ──────────────────────────

  it('handles intValue encoded as string (protobuf JSON transport)', () => {
    const attrs = { count: { intValue: '42' } }
    const result = resolveEffectiveBody('', attrs)
    const parsed = JSON.parse(result) as Record<string, unknown>
    expect(parsed['count']).toBe('42')
  })
})
