/**
 * Transcription (Papa Reo escalation), layered on Protected outputs.
 *
 * Enabling it on an agent:
 *   - sets `stt.enabled: false` in config.yaml, so recorded voice notes reach
 *     the agent as recordings (paths) instead of being transcribed into
 *     messages; nobody can talk to this agent by voice, by design;
 *   - sets `stt.local.model: large-v3-turbo`, the model the transcription
 *     plugin runs (its language detection is one of the escalation signals);
 *   - raises the memory limit to 3G unless it is already at least that
 *     (whisper large-v3-turbo peaks around 1.7 GB);
 *   - installs the `papareo-transcription` pack, first, and then renders the
 *     Papa Reo key (sealed) if one is assigned: a sealed key is rendered
 *     only while the plugin that pops it is installed and enabled.
 * Whatever it replaced is kept on the overlay and put back on disable. The
 * Papa Reo key itself is a sealed key, assigned on the Keys page as usual.
 *
 * config.yaml is spliced by line, like the tuning writer, never re-serialised.
 */

import fs from 'fs'
import path from 'path'
import { services } from '@/lib/services'
import type { Harness, TranscriptionSettings } from '@/lib/types'
import { agentDataDirForName } from './harness'
import { memoryBytes, readComposeMemory, setComposeMemory, setManagedEnv } from './ovenmitt-compose'
import { installPack, managedEnvFor, type Fail, type PackResult, pluginInstalled } from './protected-outputs'
import { swarmMapComposePath, writeComposeSecret } from './sealed-env'

export const TRANSCRIPTION_PACK = 'papareo-transcription'
export const TRANSCRIPTION_MODEL = 'large-v3-turbo'
export const TRANSCRIPTION_MEMORY = '3G'

type Splice = { ok: true; text: string; prior: { enabled: string | null; model: string | null } } | Fail

const indentOf = (l: string) => l.length - l.trimStart().length

/**
 * Set (string) or remove (null) `stt.enabled` and `stt.local.model`. Returns
 * the previous values so they can be put back. A flow-form or duplicated
 * `stt:` is refused: nobody can say which copy the runtime reads.
 */
export function spliceStt(text: string, want: { enabled: string | null; model: string | null }): Splice {
  const lines = text.split('\n')
  const headers = lines.map((l, i) => (/^stt\s*:/.test(l) ? i : -1)).filter((i) => i >= 0)
  if (headers.length > 1) return { ok: false, status: 409, error: 'config.yaml has more than one stt: section' }
  if (headers.length === 1 && !/^stt\s*:\s*(#.*)?$/.test(lines[headers[0]])) {
    return { ok: false, status: 409, error: 'config.yaml has a flow-form stt: section; edit it by hand' }
  }

  if (headers.length === 0) {
    const add = ['stt:']
    if (want.enabled !== null) add.push(`  enabled: ${want.enabled}`)
    if (want.model !== null) add.push('  local:', `    model: ${want.model}`)
    if (add.length === 1) return { ok: true, text, prior: { enabled: null, model: null } }
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return { ok: true, text: [...lines, ...add, ''].join('\n'), prior: { enabled: null, model: null } }
  }

  const start = headers[0]
  const sectionEnd = () => {
    let e = start + 1
    while (e < lines.length && (lines[e].trim() === '' || indentOf(lines[e]) > 0)) e++
    while (e > start + 1 && lines[e - 1].trim() === '') e--
    return e
  }
  let end = sectionEnd()
  const body = lines.slice(start + 1, end)
  const unit = body.find((l) => l.trim() !== '' && !l.trim().startsWith('#'))
  const ind = unit ? ' '.repeat(indentOf(unit)) : '  '

  const at = (re: RegExp, from: number, to: number) => {
    for (let i = from; i < to; i++) if (re.test(lines[i])) return i
    return -1
  }
  const value = (i: number) => lines[i].replace(/^[^:]*:\s*/, '').replace(/\s+#.*$/, '').trim()

  // stt.local.model first (it sits lower in the section, so indices above stay valid)
  let prevModel: string | null = null
  const localIdx = at(new RegExp(`^${ind}local\\s*:\\s*(#.*)?$`), start + 1, end)
  if (localIdx >= 0) {
    let lend = localIdx + 1
    while (lend < end && (lines[lend].trim() === '' || indentOf(lines[lend]) > ind.length)) lend++
    const sub = lines.slice(localIdx + 1, lend).find((l) => l.trim() !== '')
    const ind2 = sub ? ' '.repeat(indentOf(sub)) : ind + ind
    const modelIdx = at(new RegExp(`^${ind2}model\\s*:`), localIdx + 1, lend)
    if (modelIdx >= 0) {
      prevModel = value(modelIdx)
      if (want.model === null) lines.splice(modelIdx, 1)
      else lines[modelIdx] = `${ind2}model: ${want.model}`
    } else if (want.model !== null) {
      lines.splice(localIdx + 1, 0, `${ind2}model: ${want.model}`)
    }
  } else if (want.model !== null) {
    lines.splice(end, 0, `${ind}local:`, `${ind}${ind}model: ${want.model}`)
  }

  let prevEnabled: string | null = null
  end = sectionEnd()
  const enabledIdx = at(new RegExp(`^${ind}enabled\\s*:`), start + 1, end)
  if (enabledIdx >= 0) {
    prevEnabled = value(enabledIdx)
    if (want.enabled === null) lines.splice(enabledIdx, 1)
    else lines[enabledIdx] = `${ind}enabled: ${want.enabled}`
  } else if (want.enabled !== null) {
    lines.splice(start + 1, 0, `${ind}enabled: ${want.enabled}`)
  }
  return { ok: true, text: lines.join('\n'), prior: { enabled: prevEnabled, model: prevModel } }
}

export type TranscriptionStatus = {
  enabled: boolean
  // Protected outputs is on (required).
  protectedOutputs: boolean
  // A Papa Reo key is assigned to this agent (sealed).
  keyAssigned: boolean
  pluginInstalled: boolean
  memory: string | null
}

export function transcriptionStatus(harnessId: string): TranscriptionStatus | undefined {
  const h = services.harness.get(harnessId)
  if (!h) return undefined
  const file = swarmMapComposePath(services.storage.getBaseDir(), h.name)
  let memory: string | null = null
  try {
    memory = readComposeMemory(fs.readFileSync(file, 'utf-8'), h.name)
  } catch {}
  return {
    enabled: h.transcription?.enabled === true,
    protectedOutputs: h.ovenmitt?.enabled === true,
    keyAssigned: services.keys.list().some((k) => k.provider === 'papareo' && (k.assignedTo ?? []).includes(h.id)),
    pluginInstalled: pluginInstalled(h.name, 'papareo_transcribe'),
    memory,
  }
}

export async function setTranscription(
  harnessId: string,
  body: { enabled?: unknown },
): Promise<{ ok: true; status: TranscriptionStatus; restarted: boolean; pack?: PackResult } | Fail> {
  const h = services.harness.get(harnessId)
  if (!h) return { ok: false, status: 404, error: 'Harness not found' }
  if (typeof body.enabled !== 'boolean') return { ok: false, status: 400, error: 'enabled must be true or false' }
  if (body.enabled === (h.transcription?.enabled === true)) {
    return { ok: true, status: transcriptionStatus(harnessId)!, restarted: false }
  }
  if (body.enabled && !h.ovenmitt?.enabled) {
    return { ok: false, status: 409, error: 'Turn on Protected outputs first: Papa Reo transcripts go to its vault' }
  }
  const configPath = path.join(agentDataDirForName(h.name), 'config.yaml')
  const composePath = swarmMapComposePath(services.storage.getBaseDir(), h.name)
  let config: string
  let compose: string
  try {
    config = fs.readFileSync(configPath, 'utf-8')
    compose = fs.readFileSync(composePath, 'utf-8')
  } catch {
    return { ok: false, status: 409, error: 'this agent needs a config.yaml and a compose file Swarm Map wrote' }
  }
  return body.enabled ? enable(h, configPath, config, composePath, compose) : disable(h, configPath, config, composePath, compose)
}

async function enable(h: Harness, configPath: string, config: string, composePath: string, compose: string) {
  const r = spliceStt(config, { enabled: 'false', model: TRANSCRIPTION_MODEL })
  if (!r.ok) return r
  // The plugin before the key: the key is rendered only once the plugin that
  // pops it is installed and enabled (managedEnvFor). installPack edits
  // config.yaml, so the stt splice is redone on the file it leaves.
  const pack = pluginInstalled(h.name, 'papareo_transcribe') ? undefined : await installPack(h, TRANSCRIPTION_PACK)
  const afterPack = fs.readFileSync(configPath, 'utf-8')
  const r2 = afterPack === config ? r : spliceStt(afterPack, { enabled: 'false', model: TRANSCRIPTION_MODEL })
  if (!r2.ok) return r2
  const current = readComposeMemory(compose, h.name)
  // No memory line (a hand-made compose) means nothing to raise; the card shows it.
  const raise = current !== null && memoryBytes(current) < memoryBytes(TRANSCRIPTION_MEMORY)
  const withMemory = raise ? setComposeMemory(compose, h.name, TRANSCRIPTION_MEMORY) : compose
  const nextCompose = setManagedEnv(withMemory, h.name, managedEnvFor(h))
  const settings: TranscriptionSettings = {
    enabled: true,
    prior: { sttEnabled: r.prior.enabled, sttModel: r.prior.model, memory: raise ? current : null },
  }
  fs.writeFileSync(configPath, r2.text, 'utf-8')
  if (nextCompose !== compose) writeComposeSecret(composePath, nextCompose)
  services.harness.updateConfig(h.id, {
    transcription: settings,
    ...(raise ? { resources: { ...(h.resources ?? {}), memory: TRANSCRIPTION_MEMORY } } : {}),
  })
  services.audit.append({ who: 'admin', what: 'transcription:enable', target: h.name, meta: { memoryRaised: raise } })
  services.harness.restart(h.id, 'recreate')
  return { ok: true as const, status: transcriptionStatus(h.id)!, restarted: true, ...(pack ? { pack } : {}) }
}

async function disable(h: Harness, configPath: string, config: string, composePath: string, compose: string) {
  const prior = h.transcription?.prior
  const r = spliceStt(config, { enabled: prior?.sttEnabled ?? null, model: prior?.sttModel ?? null })
  if (!r.ok) return r
  fs.writeFileSync(configPath, r.text, 'utf-8')
  if (prior?.memory) {
    writeComposeSecret(composePath, setComposeMemory(compose, h.name, prior.memory))
  }
  services.harness.updateConfig(h.id, {
    transcription: { enabled: false },
    ...(prior?.memory ? { resources: { ...(h.resources ?? {}), memory: prior.memory } } : {}),
  })
  services.audit.append({ who: 'admin', what: 'transcription:disable', target: h.name })
  services.harness.restart(h.id, 'recreate')
  return { ok: true as const, status: transcriptionStatus(h.id)!, restarted: true }
}
