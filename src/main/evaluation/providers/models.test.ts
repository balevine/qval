import { describe, expect, it } from 'vitest'
import { costForUsage, getPricing } from './models'

describe('getPricing', () => {
  it('is free for Ollama and known for mapped Anthropic ids', () => {
    expect(getPricing('ollama', 'anything')).toEqual({ inputPerM: 0, outputPerM: 0, currency: 'USD' })
    expect(getPricing('anthropic', 'claude-sonnet-4-6')?.inputPerM).toBe(3)
  })

  it('matches by longest prefix for date-suffixed ids', () => {
    expect(getPricing('anthropic', 'claude-haiku-4-5-20251001')?.outputPerM).toBe(5)
  })

  it('returns null for an unknown model', () => {
    expect(getPricing('anthropic', 'claude-future-9')).toBeNull()
  })
})

describe('costForUsage', () => {
  it('computes USD from token usage, null when unknown', () => {
    const cost = costForUsage('anthropic', 'claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(cost).toBeCloseTo(18) // $3 in + $15 out
    expect(costForUsage('anthropic', 'unknown-model', { inputTokens: 1, outputTokens: 1 })).toBeNull()
    expect(costForUsage('ollama', 'llama', { inputTokens: 9e9, outputTokens: 9e9 })).toBe(0)
  })
})
