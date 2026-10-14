#!/usr/bin/env node
/**
 * Final state check for the 0.2.58 ship: app reachable, data counts, configured models.
 *
 * Usage: node products/bosom-friend/qa/probes/final-state.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 31280
const API = 'http://127.0.0.1:' + String(PORT) + '/bosom-friend/api'
const INSTALLED = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Bosom Friend', 'Bosom Friend.exe')
const ROOT = join(homedir(), '.bosom-friend', 'bosom-friend')
const lines = []
/** @param text - line to record. */
function say(text) { lines.push(text); console.log(text) }

/** @param path - api path. */
async function api(path) {
  try {
    const res = await fetch(API + '/' + path, { signal: AbortSignal.timeout(20000) })
    return await res.json()
  }
  catch (error) { return { error: String(error) } }
}

/** @returns whether the app answers. */
async function reachable() {
  try {
    const res = await fetch('http://127.0.0.1:' + String(PORT) + '/bosom-friend/', { signal: AbortSignal.timeout(4000) })
    return res.ok
  }
  catch { return false }
}

let up = await reachable()
if (!up && existsSync(INSTALLED)) {
  spawn(INSTALLED, [], { stdio: 'ignore', detached: true }).unref()
  say('started the installed app')
  for (let i = 0; i < 60 && !up; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5000))
    up = await reachable()
  }
}
say('app reachable=' + String(up))

/** @param name - json file. @returns the value array of the store envelope. */
function storeValue(name) {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, name), 'utf8'))
    return Array.isArray(parsed?.value) ? parsed.value : (Array.isArray(parsed) ? parsed : [])
  }
  catch { return [] }
}
say('contents=' + String(storeValue('contents.json').length))
say('draft-generations=' + String(storeValue('draft-generations.json').length))
say('long-video-tasks=' + String(storeValue('long-video-tasks.json').length))
try { say('uploads files=' + String(readdirSync(join(ROOT, 'uploads')).length)) } catch { say('uploads files=?') }

if (up) {
  const llm = await api('ai/user-llm')
  say('llm video=' + JSON.stringify({ baseUrl: llm?.data?.video?.baseUrl, model: llm?.data?.video?.model, hasApiKey: llm?.data?.video?.hasApiKey }))
  say('llm chat=' + JSON.stringify({ model: llm?.data?.model, hasApiKey: llm?.data?.hasApiKey }))
  const need = await api('long-videos/script-requirement?producer=scene&targetSeconds=300')
  say('script-requirement=' + JSON.stringify(need?.data ?? need))
}

writeFileSync(join(tmpdir(), 'bf-final-state.txt'), lines.join('\n') + '\n', 'utf8')
process.exit(0)
