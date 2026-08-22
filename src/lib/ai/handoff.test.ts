import { describe, it, expect } from 'vitest'
import { buildHandoffSummary } from './handoff'

describe('buildHandoffSummary', () => {
  it('notes the reply count and quotes the last customer message', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'I want a refund' },
      ],
      replyCount: 2,
      reason: 'model_requested',
    })
    expect(summary).toBe(
      '🤖 AI agent handed off after 2 replies. It asked for a person to continue. Last customer message: “I want a refund”',
    )
  })

  it('uses the singular "reply" for a count of one', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'help' }],
      replyCount: 1,
      reason: 'model_requested',
    })
    expect(summary).toContain('after 1 reply.')
  })

  it('says "without replying" when the bot bailed on the first inbound', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'agent please' }],
      replyCount: 0,
      reason: 'cap_reached',
    })
    expect(summary).toContain('handed off without replying.')
    expect(summary).toContain('“agent please”')
  })

  it('picks the most recent customer turn, ignoring assistant turns', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'a reply' },
      ],
      replyCount: 1,
      reason: 'model_requested',
    })
    expect(summary).toContain('“second”')
  })

  it('collapses whitespace and truncates a long message', () => {
    const long = 'x'.repeat(300)
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: long }],
      replyCount: 0,
      reason: 'model_requested',
    })
    expect(summary).toContain('…')
    // 160-char cap on the quote; the whole note stays well under 300.
    expect(summary.length).toBeLessThan(300)
  })

  it('degrades gracefully when there is no customer message', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'assistant', content: 'greeting' }],
      replyCount: 0,
      reason: 'no_reply',
    })
    expect(summary).toBe(
      '🤖 AI agent handed off without replying. It produced no reply to send.',
    )
  })

  it('states why the bot stopped', () => {
    const messages = [{ role: 'user' as const, content: 'hola' }]
    expect(
      buildHandoffSummary({ messages, replyCount: 3, reason: 'cap_reached' }),
    ).toContain('ran out of replies')
    expect(
      buildHandoffSummary({ messages, replyCount: 2, reason: 'meter_gate' }),
    ).toContain('how many meters')
  })

  it('skips synthetic system notes when quoting the customer', () => {
    // The dispatcher pushes these as user-role turns; quoting one tells
    // the agent picking up the thread nothing about the customer.
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'Así es, son todos' },
        {
          role: 'user',
          content: '[NOTA DEL SISTEMA — fecha y hora actual: sábado ...]',
        },
      ],
      replyCount: 3,
      reason: 'cap_reached',
    })
    expect(summary).toContain('“Así es, son todos”')
    expect(summary).not.toContain('NOTA DEL SISTEMA')
  })
})
