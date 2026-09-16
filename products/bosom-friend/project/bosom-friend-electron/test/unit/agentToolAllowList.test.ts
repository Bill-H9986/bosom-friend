import { describe, expect, it } from 'vitest'
import { AppControlToolName, ContentToolName } from '../../../aitoearn-backend/apps/aitoearn-ai/src/core/agent/agent.constants'

describe('Agent tool allow list contract', () => {
  it('exposes local account and publish tools to the backend agent', () => {
    expect(AppControlToolName.ListAccounts).toBe('appListAccounts')
    expect(AppControlToolName.Publish).toBe('appPublish')
  })

  it('exposes content creation/draft tools to the backend agent', () => {
    expect(ContentToolName.CreateDraft).toBe('createDraft')
    expect(ContentToolName.GetDraftGroupInfoByName).toBe('getDraftGroupInfoByName')
    expect(ContentToolName.ListDraftGroups).toBe('listDraftGroups')
  })
})
