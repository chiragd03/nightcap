import { describe, expect, test } from 'vitest'
import { Progress } from './playback'
import type { Session } from './session'

// Only what Progress asks of the session: started, and no picks waiting.
const session = { hasStarted: () => true, pickWaiting: () => false, picksToSend: () => ({}) } as unknown as Session

describe('progress saves', () => {
  test('a place within the length is saved', () => {
    expect(new Progress().next(session, 60_000, 7_200_000)).toMatchObject({ position: 60_000, duration: 7_200_000 })
  })

  test('a place at or past the length is not (an error clip measured against the film\'s place)', () => {
    const p = new Progress()
    expect(p.next(session, 3_000_000, 30_000)).toBeNull()
    expect(p.next(session, 30_000, 30_000)).toBeNull()
  })

  test('the end reached is saved as the whole length', () => {
    expect(new Progress().next(session, 0, 7_200_000, true)).toMatchObject({ position: 7_200_000, duration: 7_200_000 })
  })
})
