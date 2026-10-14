import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '../src/index.ts'

class FakeTransport implements JsonRpcTransportPeer {
  async request(method: string, params: object): Promise<unknown> {
    throw new Error('the SDK server should not call host JSON-RPC method ' + method + ' with ' + JSON.stringify(params))
  }

  notify(): void {}
}

/** One `agents.create` call captured for assertions. */
interface CreatedAgent {
  meta: { cwd?: string, agentPreset?: string }
  setup?: (agentCtx: Context) => Promise<void>
}

/**
 * A context stub carrying only what `createSession` reads: the optional
 * agent-presets service, the lifecycle subscriptions, and the agent factory.
 * The three branches under test are decisions taken before any session exists,
 * so a full harness would add assembly work without covering more of them.
 */
function stubContext(created: CreatedAgent[], presets: unknown): Context {
  return {
    get: (name: string): unknown => (name === 'agentPresets' ? presets : undefined),
    on: () => () => {},
    agents: {
      create: async (options: CreatedAgent) => {
        created.push(options)
        return { handle: {} }
      },
    },
  } as unknown as Context
}

/** Drive the private creation path the prompt path reaches through getOrCreateSession. */
function createSession(server: HarnessSdkJsonRpcServer, sessionId: string): Promise<unknown> {
  return (server as unknown as { createSession(id: string): Promise<unknown> }).createSession(sessionId)
}

describe('SDK server agent preset composition', () => {
  it('joins no preset when the deployment configures none', async () => {
    const created: CreatedAgent[] = []
    const server = new HarnessSdkJsonRpcServer(stubContext(created, undefined), new FakeTransport())

    await createSession(server, 's-plain')

    expect(created).toHaveLength(1)
    expect(created[0]?.setup).toBeUndefined()
    expect(created[0]?.meta.agentPreset).toBeUndefined()
    expect(created[0]?.meta.cwd).toBe(process.cwd())
  })

  it('fails loud when a configured preset cannot be mounted', async () => {
    const created: CreatedAgent[] = []
    const server = new HarnessSdkJsonRpcServer(stubContext(created, undefined), new FakeTransport(), { agentPreset: 'creator' })

    await expect(createSession(server, 's-missing-service')).rejects.toThrow(/agent-presets service is not loaded/)
    expect(created).toHaveLength(0)
  })

  it('mounts the configured preset before the agent is published', async () => {
    const created: CreatedAgent[] = []
    const mount = vi.fn(async () => {})
    const server = new HarnessSdkJsonRpcServer(stubContext(created, { mount }), new FakeTransport(), { agentPreset: 'creator' })

    await createSession(server, 's-composed')

    expect(created).toHaveLength(1)
    expect(created[0]?.meta.agentPreset).toBe('creator')
    const setup = created[0]?.setup
    expect(setup).toBeTypeOf('function')
    const agentCtx = { tag: 'agent-scope' } as unknown as Context
    await setup?.(agentCtx)
    expect(mount).toHaveBeenCalledTimes(1)
    expect(mount).toHaveBeenCalledWith(agentCtx, 'creator')
  })
})
