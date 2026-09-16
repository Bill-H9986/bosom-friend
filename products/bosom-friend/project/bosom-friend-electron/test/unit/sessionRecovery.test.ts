import { describe, expect, it } from 'vitest'
import { isRecoveredTaskId } from '../../../aitoearn-web/src/store/agent/sessionRecovery'

describe('session recovery routing', () => {
  it('detects when the backend has created a new task id after session recovery', () => {
    expect(isRecoveredTaskId('old-task', 'new-task')).toBe(true)
    expect(isRecoveredTaskId('same-task', 'same-task')).toBe(false)
    expect(isRecoveredTaskId('same-task', undefined)).toBe(false)
  })
})
