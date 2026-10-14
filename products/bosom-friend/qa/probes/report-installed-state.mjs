#!/usr/bin/env node
/**
 * Report the running instance state: gears the model actually declares, the new script-requirement
 * endpoint answer, and the current user-facing counts.
 *
 * Usage: node products/bosom-friend/qa/probes/report-installed-state.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 31280
const API = 'http://127.0.0.1:' + String(PORT) + '/bosom-friend/api'
const INSTALLED = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bosom Friend', 'Bosom Friend.exe')
const lines = []
/** @param text - line to record. */
function say(text) { lines.push(text); console.log(text) }

/** @param path - api path. */
async function api(path) {
  try {
    const res = await fetch(API + '/' + path, { signal: AbortSignal.timeout(20000) })
    const text = await res.text()
    try { return JSON.parse(text) } catch { return { raw: text.slice(0, 200) } }
  }
  catch (error) { return { error: String(error) } }
}

/** @returns whether the app answers. */
async function ready() {
  try {
    const res = await fetch('http://127.0.0.1:' + String(PORT) + '/bosom-friend/', { signal: AbortSignal.timeout(4000) })
    return res.ok
  }
  catch { return false }
}

let up = await ready()
if (!up && existsSync(INSTALLED)) {
  spawn(INSTALLED, [], { stdio: 'ignore', detached: true }).unref()
  say('started installed app')
  for (let i = 0; i < 60 && !up; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5000))
    up = await ready()
  }
}
say('reachable=' + String(up))

if (up) {
  const pricing = await api('ai/draft-generation/pricing')
  for (const model of pricing?.data?.models ?? [])
    say('model ' + String(model.name) + ' durations=' + JSON.stringify(model.durations ?? []) + ' longDurations=' + JSON.stringify(model.longDurations ?? []))
  const range = await api('long-videos/script-requirement?producer=scene&targetSeconds=300')
  say('script-requirement(scene,300)=' + JSON.stringify(range?.data ?? range).slice(0, 300))
  const range2 = await api('long-videos/script-requirement?producer=scene&targetSeconds=90')
  say('script-requirement(scene,90)=' + JSON.stringify(range2?.data ?? range2).slice(0, 300))
  const gens = await api('ai/draft-generation?page=1&pageSize=50')
  say('generations total=' + String(gens?.data?.total ?? '?'))
  const contents = await api('contents?page=1&pageSize=1')
  say('contents total=' + String(contents?.data?.total ?? '?'))
  const llm = await api('ai/user-llm')
  say('llm video=' + JSON.stringify({ baseUrl: llm?.data?.video?.baseUrl, model: llm?.data?.video?.model, hasApiKey: llm?.data?.video?.hasApiKey })
    + ' chat=' + JSON.stringify({ model: llm?.data?.model, hasApiKey: llm?.data?.hasApiKey }))
}

writeFileSync(join(tmpdir(), 'bf-installed-state.txt'), lines.join('\n') + '\n', 'utf8')
process.exit(0)
