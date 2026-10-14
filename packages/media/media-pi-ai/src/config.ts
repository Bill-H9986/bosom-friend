/**
 * Configuration of the pi-ai media provider: one route per vendor deployment, resolved per request
 * over the optional `media-pi-ai` user-settings section so a changed endpoint, credential, or dialect
 * reaches the next call without a restart.
 * ```yaml
 * - id: media
 *   name: '@deepseek-ai/dsh-media-pi-ai'
 *   config:
 *     providers:
 *       agnes:
 *         displayName: Agnes AI
 *         apiKeyEnv: BF_AGNES_BUILTIN_API_KEY
 *         api: agnes
 *         baseURL: https://api.agnes-ai.cn/v1
 * ```
 *
 * @module @deepseek-ai/dsh-media-pi-ai/config
 */

import z from '@deepseek-ai/schemastery'

/** Wire dialect of one route: request field names and the endpoint layout the vendor accepts. */
export const MEDIA_APIS = ['openai', 'agnes'] as const

/** Wire dialect of one route. */
export type MediaApi = typeof MEDIA_APIS[number]

/** One vendor deployment this provider can reach. */
export interface PiAiMediaRoute {
  /** Label for configuration surfaces; the route id is used when omitted. */
  readonly displayName?: string
  /** Vendor base URL, with or without a version suffix (for example `https://api.agnes-ai.cn/v1`). */
  readonly baseURL: string
  /** Credential ref resolved through the credentials seam, or the environment variable holding the key. */
  readonly apiKeyEnv?: string
  /** Wire dialect; `openai` (OpenAI-compatible field names) when omitted. */
  readonly api?: MediaApi
}

/** Provider configuration. */
export interface Config {
  /** Routes by id; a request names one in its `provider` field. */
  readonly providers: Record<string, PiAiMediaRoute>
}

/** Schemastery schema of {@link Config}. */
export const Config: z<Config> = z.object({
  providers: z.dict(z.object({
    displayName: z.string(),
    baseURL: z.string().required(),
    apiKeyEnv: z.string().role('credential-ref'),
    api: z.union(MEDIA_APIS),
  })),
})

/**
 * Look one route up.
 * @param config - current provider configuration.
 * @param route - route id from the request.
 * @returns the route, or `undefined` when the configuration declares no such id.
 */
export function routeOf(config: Config, route: string): PiAiMediaRoute | undefined {
  return config.providers[route]
}
