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
 *   - adds a `papareo` vault to Protected outputs if there is none (no
 *     destinations: the card is where chats are allowed to receive it);
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
import {
  ensureVault,
  installPack,
  managedEnvFor,
  packNeedsInstall,
  PAPAREO_VAULT,
  type Fail,
  type PackResult,
  pluginInstalled,
  pluginVersion,
  type PluginVersion,
  vaultsOf,
} from './protected-outputs'
import { modelHosting, type ModelHost } from './model-hosting'
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
  pluginVersion: PluginVersion
  // Protected outputs has the papareo vault the plugin writes to.
  vault: boolean
  memory: string | null
  kaitiakitanga: KaitiakitangaStatus
}

export type KaitiakitangaStatus = {
  compliant: boolean
  // The SOUL.md declaration is in place (it can be edited away by hand).
  declared: boolean
  // Where the agent's model calls go, for the confirm dialog.
  hosts: ModelHost[]
  remote: ModelHost[]
  hostedKeys: string[]
}

export const KAITIAKITANGA_URL = 'https://papareo.io/kaitiakitanga'
// What the operator must type to declare an agent with remote model hosts compliant.
export const REMOTE_CONFIRMATION = 'I CONFIRM'
const SOUL_START = '<!-- swarm-map:kaitiakitanga start (managed by Swarm Map: change it on the Transcription card) -->'
const SOUL_END = '<!-- swarm-map:kaitiakitanga end -->'
const SOUL_BLOCK = [
  SOUL_START,
  `## Kaitiakitanga License`,
  ``,
  `The people who run you have confirmed that you are deployed in line with the Kaitiakitanga License (${KAITIAKITANGA_URL}). You may read and work with Papa Reo transcripts you are given, when the person asks, within its terms: never pass them to other services or tools that may store or learn from them.`,
  SOUL_END,
].join('\n')

/**
 * SOUL.md with the Swarm Map Kaitiakitanga block added (on) or removed
 * (off). Only the lines between the markers are touched; the rest of the
 * file is the operator's and the agent's.
 */
export function spliceSoul(text: string, on: boolean): string {
  const start = text.indexOf(SOUL_START.slice(0, 40))
  const end = text.indexOf(SOUL_END)
  let base = text
  if (start >= 0 && end > start) {
    const before = text.slice(0, start).replace(/\n+$/, '')
    const after = text.slice(end + SOUL_END.length).replace(/^\n+/, '')
    base = before && after ? `${before}\n\n${after}` : before || after
    if (base && !base.endsWith('\n')) base += '\n'
  }
  if (!on) return base
  const sep = base === '' ? '' : base.endsWith('\n') ? '\n' : '\n\n'
  return base + sep + SOUL_BLOCK + '\n'
}

function soulPath(agentName: string): string {
  return path.join(agentDataDirForName(agentName), 'SOUL.md')
}

function readText(p: string): string {
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return ''
  }
}

function kaitiakitangaStatus(h: Harness): KaitiakitangaStatus {
  const dir = agentDataDirForName(h.name)
  const hosting = modelHosting(readText(path.join(dir, 'config.yaml')), readText(path.join(dir, '.env')))
  return {
    compliant: h.transcription?.kaitiakitanga?.compliant === true,
    declared: readText(soulPath(h.name)).includes(SOUL_END),
    ...hosting,
  }
}

const hostLabel = (m: ModelHost) => `${m.role}: ${m.baseUrl ?? m.provider ?? 'unknown'}`

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
    pluginVersion: pluginVersion(h.name, 'papareo_transcribe'),
    vault: vaultsOf(h.ovenmitt).some((v) => v.name === PAPAREO_VAULT),
    memory,
    kaitiakitanga: kaitiakitangaStatus(h),
  }
}

/**
 * Declare (or withdraw) that this agent is deployed in line with the
 * Kaitiakitanga License. Needs Transcription on. When any configured model
 * host is remote, the body must carry confirm: "I CONFIRM", checked here and
 * not only in the dialog. On: the SOUL.md block, the plugin's flag in the
 * compose environment, an audit entry, and a recreate so both take effect.
 */
export async function setKaitiakitanga(
  harnessId: string,
  body: { kaitiakitanga?: unknown; confirm?: unknown },
): Promise<{ ok: true; status: TranscriptionStatus; restarted: boolean } | Fail> {
  const h = services.harness.get(harnessId)
  if (!h) return { ok: false, status: 404, error: 'Harness not found' }
  if (typeof body.kaitiakitanga !== 'boolean') return { ok: false, status: 400, error: 'kaitiakitanga must be true or false' }
  if (!h.transcription?.enabled) return { ok: false, status: 409, error: 'Turn on Transcription first' }
  const on = body.kaitiakitanga
  const k = kaitiakitangaStatus(h)
  if (on && k.remote.length > 0 && body.confirm !== REMOTE_CONFIRMATION) {
    return {
      ok: false,
      status: 400,
      error: `This agent sends model calls to remote hosts (${k.remote.map(hostLabel).join('; ')}). Type ${REMOTE_CONFIRMATION} to declare it compliant anyway.`,
    }
  }
  const composePath = swarmMapComposePath(services.storage.getBaseDir(), h.name)
  let compose: string
  try {
    compose = fs.readFileSync(composePath, 'utf-8')
  } catch {
    return { ok: false, status: 409, error: 'this agent needs a compose file Swarm Map wrote' }
  }
  const settings: TranscriptionSettings = {
    ...h.transcription,
    kaitiakitanga: on
      ? { compliant: true, at: new Date().toISOString(), remoteHosts: k.remote.map(hostLabel) }
      : { compliant: false },
  }
  const soul = soulPath(h.name)
  const soulBefore = readText(soul)
  const soulAfter = spliceSoul(soulBefore, on)
  if (soulAfter !== soulBefore) fs.writeFileSync(soul, soulAfter, 'utf-8')
  services.harness.updateConfig(h.id, { transcription: settings })
  const nextCompose = setManagedEnv(compose, h.name, managedEnvFor({ ...h, transcription: settings }))
  if (nextCompose !== compose) writeComposeSecret(composePath, nextCompose)
  services.audit.append({
    who: 'admin',
    what: on ? 'transcription:kaitiakitanga:declare' : 'transcription:kaitiakitanga:withdraw',
    target: h.name,
    meta: on ? { remoteHosts: k.remote.map(hostLabel), hostedKeys: k.hostedKeys } : {},
  })
  services.harness.restart(h.id, 'recreate')
  return { ok: true, status: transcriptionStatus(h.id)!, restarted: true }
}

export async function setTranscription(
  harnessId: string,
  body: { enabled?: unknown },
): Promise<{ ok: true; status: TranscriptionStatus; restarted: boolean; pack?: PackResult } | Fail> {
  const h = services.harness.get(harnessId)
  if (!h) return { ok: false, status: 404, error: 'Harness not found' }
  if (typeof body.enabled !== 'boolean') return { ok: false, status: 400, error: 'enabled must be true or false' }
  if (body.enabled && !h.ovenmitt?.enabled) {
    return { ok: false, status: 409, error: 'Turn on Protected outputs first: Papa Reo transcripts go to its vault' }
  }
  // Before the no-op check, so enabling again sets up a vault that is missing
  // (an agent that had Transcription on before vaults were configurable).
  const vault = body.enabled ? await ensureVault(harnessId, PAPAREO_VAULT) : null
  if (vault && !vault.ok) return vault
  if (body.enabled === (h.transcription?.enabled === true)) {
    return { ok: true, status: transcriptionStatus(harnessId)!, restarted: vault?.restarted === true }
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
  // Missing, or not the pinned tag: (re)install, so moving the pin and
  // switching Transcription off and on is how an agent is updated.
  const need = packNeedsInstall(h.name, 'papareo_transcribe')
  const pack = need.install ? await installPack(h, TRANSCRIPTION_PACK, { overwrite: need.overwrite }) : undefined
  const afterPack = fs.readFileSync(configPath, 'utf-8')
  const r2 = afterPack === config ? r : spliceStt(afterPack, { enabled: 'false', model: TRANSCRIPTION_MODEL })
  if (!r2.ok) return r2
  const current = readComposeMemory(compose, h.name)
  // No memory line (a hand-made compose) means nothing to raise; the card shows it.
  const raise = current !== null && memoryBytes(current) < memoryBytes(TRANSCRIPTION_MEMORY)
  const withMemory = raise ? setComposeMemory(compose, h.name, TRANSCRIPTION_MEMORY) : compose
  // A Kaitiakitanga declaration survives off/on (how the plugin is updated),
  // but only while the agent's remote model hosts are the ones it was made
  // with; otherwise it lapses and must be made again.
  const kept = h.transcription?.kaitiakitanga
  const remoteNow = kaitiakitangaStatus(h).remote.map(hostLabel)
  const stillValid =
    kept?.compliant === true && JSON.stringify([...(kept.remoteHosts ?? [])].sort()) === JSON.stringify([...remoteNow].sort())
  const settings: TranscriptionSettings = {
    enabled: true,
    prior: { sttEnabled: r.prior.enabled, sttModel: r.prior.model, memory: raise ? current : null },
    ...(kept ? { kaitiakitanga: stillValid ? kept : { compliant: false } } : {}),
  }
  const nextCompose = setManagedEnv(withMemory, h.name, managedEnvFor({ ...h, transcription: settings }))
  const soul = soulPath(h.name)
  const soulBefore = readText(soul)
  const soulAfter = spliceSoul(soulBefore, stillValid)
  if (soulAfter !== soulBefore) fs.writeFileSync(soul, soulAfter, 'utf-8')
  fs.writeFileSync(configPath, r2.text, 'utf-8')
  if (nextCompose !== compose) writeComposeSecret(composePath, nextCompose)
  services.harness.updateConfig(h.id, {
    transcription: settings,
    ...(raise ? { resources: { ...(h.resources ?? {}), memory: TRANSCRIPTION_MEMORY } } : {}),
  })
  services.audit.append({
    who: 'admin',
    what: 'transcription:enable',
    target: h.name,
    meta: { memoryRaised: raise, ...(kept?.compliant && !stillValid ? { kaitiakitangaLapsed: remoteNow } : {}) },
  })
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
  // While off, the declaration is out of SOUL.md and the flag is off; the
  // setting is kept so switching back on (to update the plugin) restores it.
  const soul = soulPath(h.name)
  const soulBefore = readText(soul)
  const soulAfter = spliceSoul(soulBefore, false)
  if (soulAfter !== soulBefore) fs.writeFileSync(soul, soulAfter, 'utf-8')
  const off: TranscriptionSettings = {
    enabled: false,
    ...(h.transcription?.kaitiakitanga ? { kaitiakitanga: h.transcription.kaitiakitanga } : {}),
  }
  const current = fs.readFileSync(composePath, 'utf-8')
  const unflagged = setManagedEnv(current, h.name, { PAPAREO_KAITIAKITANGA_COMPLIANT: null })
  if (unflagged !== current) writeComposeSecret(composePath, unflagged)
  services.harness.updateConfig(h.id, {
    transcription: off,
    ...(prior?.memory ? { resources: { ...(h.resources ?? {}), memory: prior.memory } } : {}),
  })
  services.audit.append({ who: 'admin', what: 'transcription:disable', target: h.name })
  services.harness.restart(h.id, 'recreate')
  return { ok: true as const, status: transcriptionStatus(h.id)!, restarted: true }
}
