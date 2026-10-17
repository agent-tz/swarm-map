/**
 * Protected outputs: an ovenmitt vault per agent, for tool outputs that must
 * never enter an LLM's context (e.g. Papa Reo transcripts, which the
 * Kaitiakitanga License forbids sending to services that may keep them).
 *
 * Turning it on for an agent:
 *   0. installs the `protected-outputs` pack (bridge plugin + skill) first,
 *      so the plugin that pops the credential exists before it is rendered;
 *   1. writes the daemon's config (one vault, one send destination per ticked
 *      platform; default none) to <dataDir>/compose/<name>/ovenmitt/;
 *   2. adds the ovenmitt-<name> sidecar to the agent's compose, surgically
 *      (works on deploy-born composes too) and starts it;
 *   3. issues the agent's consumer credential and keeps it encrypted in its
 *      own file, never on the harness overlay, so no harness API returns it;
 *   4. renders the credential and socket path into the hermes service's
 *      compose `environment:` (sealed, like Papa Reo's key) — only if the
 *      bridge plugin is installed and enabled — and recreates once.
 * Any failure in 1–4 puts the compose, config and overlay back as they were.
 * If the pack can't install, the sidecar still comes up but the credential
 * is held back until the plugin is there (the card shows it).
 *
 * Changing destinations or TTL later only rewrites the config and restarts
 * the daemon; the agent keeps running.
 */

import fs from 'fs'
import path from 'path'
import { services } from '@/lib/services'
import { SEALED_PROVIDER_VARS } from '@/lib/key-providers'
import { SURFACES, SURFACE_SLUGS } from '@/lib/surfaces/registry'
import type { Harness, OvenmittSettings } from '@/lib/types'
import { installArtifacts } from './artifacts-manifest'
import { ensurePluginsEnabled } from './artifacts-sync'
import { loadBasePackage, readStamp, STAMP_FILE, validateSelection } from './base-package'
import { Encryption } from './encryption'
import { agentDataDirForName } from './harness'
import {
  DEFAULT_TTL,
  auditCheck,
  daemonHealth,
  issueCredential,
  ovenmittConfigPath,
  ovenmittImage,
  removeSidecar,
  renderOvenmittToml,
  revokeCredential,
  startSidecar,
  validateOvenmitt,
  type AuditSummary,
  type DaemonHealth,
} from './ovenmitt'
import { applyOvenmitt, MANAGED_ENV_NAMES, OVENMITT_SOCKET, removeOvenmitt, setManagedEnv } from './ovenmitt-compose'
import { pluginReady, sealedConsumerReady, swarmMapComposePath, writeComposeSecret } from './sealed-env'

export const BRIDGE_PLUGIN = 'ovenmitt_bridge'

export const PROTECTED_OUTPUTS_PACK = 'protected-outputs'
const CREDENTIALS_FILE = 'ovenmitt-credentials.json'
const AUDIT_FILE = 'ovenmitt-audit.json'

export type Fail = { ok: false; status: 400 | 404 | 409 | 500; error: string }

export type PackResult = { pack: string; installed: boolean; error?: string; pluginsEnabled?: string[] }

export type ProtectedOutputsStatus = {
  enabled: boolean
  destinations: string[]
  ttl: string
  // Platforms this agent is connected to (candidates for destinations).
  liveSurfaces: string[]
  credentialIssued: boolean
  credentialId?: string
  daemon: DaemonHealth
  // Swarm Map wrote this agent's compose; nothing can be enabled otherwise.
  composeManaged: boolean
  pluginInstalled: boolean
  audit: AuditSummary | null
}

function dataDir(): string {
  return services.storage.getBaseDir()
}

// --- the consumer credential, encrypted at rest in its own 0600 file --------

function credentialFile(): string {
  return path.join(dataDir(), CREDENTIALS_FILE)
}

function readCredentialStore(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(credentialFile(), 'utf-8')) as Record<string, string>
  } catch {
    return {}
  }
}

function storeCredential(harnessId: string, token: string | null): void {
  const store = readCredentialStore()
  if (token === null) delete store[harnessId]
  else store[harnessId] = new Encryption(dataDir()).encrypt(token)
  fs.writeFileSync(credentialFile(), JSON.stringify(store, null, 2), { mode: 0o600 })
  fs.chmodSync(credentialFile(), 0o600)
}

function storedCredential(harnessId: string): string | null {
  const enc = readCredentialStore()[harnessId]
  if (!enc) return null
  try {
    return new Encryption(dataDir()).decrypt(enc)
  } catch {
    return null
  }
}

// --- what Swarm Map renders into the hermes service's environment ----------

/**
 * Every managed environment entry for this agent: the sealed provider keys
 * assigned to it, and the ovenmitt socket and credential when Protected
 * outputs is on. null clears an entry, so the result fully describes the
 * managed part of `environment:`.
 *
 * A secret is rendered only while the plugin that pops it is installed and
 * enabled on the agent. Otherwise nothing would take it out of the gateway's
 * environment, and every terminal child would inherit it.
 */
export function managedEnvFor(harness: Harness): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  const agentDir = agentDataDirForName(harness.name)
  const keys = services.keys.list()
  for (const [provider, varName] of Object.entries(SEALED_PROVIDER_VARS)) {
    const key = keys.find((k) => k.provider === provider && (k.assignedTo ?? []).includes(harness.id))
    const ready = key ? sealedConsumerReady(agentDir, varName) : false
    out[varName] = key && ready ? services.keys.getDecryptedValue(key.id) ?? null : null
  }
  const on = harness.ovenmitt?.enabled === true && pluginReady(agentDir, BRIDGE_PLUGIN)
  const credential = on ? storedCredential(harness.id) : null
  out.OVENMITT_SOCKET = on && credential ? OVENMITT_SOCKET : null
  out.OVENMITT_CONSUMER_CREDENTIAL = credential
  return out
}

/**
 * Put the sidecar and the sealed environment back onto a compose that was
 * just regenerated from a template (the settings route's VPN/resources
 * path). Without this, a regeneration would silently drop both.
 */
export function reapplyManagedWiring(compose: string, harness: Harness): string {
  let out = compose
  if (harness.ovenmitt?.enabled) {
    out = applyOvenmitt(out, harness.name, {
      image: ovenmittImage(),
      configPath: ovenmittConfigPath(dataDir(), harness.name),
    })
  }
  const env = managedEnvFor(harness)
  const present = MANAGED_ENV_NAMES.some((n) => out.includes(`- ${n}=`) || out.includes(`- "${n}=`))
  // Nothing to set and nothing to clear: leave the compose exactly as generated.
  if (!present && Object.values(env).every((v) => v === null)) return out
  return setManagedEnv(out, harness.name, env)
}

/** True when any sealed value sits in this compose (it must stay 0600). */
export function holdsSealedValues(harness: Harness): boolean {
  return Object.values(managedEnvFor(harness)).some((v) => v !== null)
}

// --- surfaces ----------------------------------------------------------------

/** Platforms the agent is connected to: the surface's first credential is set. */
export function liveSurfaces(agentName: string): string[] {
  let env = ''
  try {
    env = fs.readFileSync(path.join(agentDataDirForName(agentName), '.env'), 'utf-8')
  } catch {
    return []
  }
  return SURFACE_SLUGS.filter((slug) => {
    const varName = SURFACES[slug].credentials[0]
    return new RegExp(`^${varName}=\\S+`, 'm').test(env)
  })
}

// --- packs -------------------------------------------------------------------

/**
 * Install one pack's artifacts into an existing agent, including git-sourced
 * ones (fetched at their pinned tag and trust-gated), enable its plugins and
 * record the pack in the agent's stamp so drift checks and forbiddenPacks see
 * it. Never throws: the result says what happened.
 */
export async function installPack(harness: Harness, pack: string): Promise<PackResult> {
  try {
    const agentDir = agentDataDirForName(harness.name)
    const repoRoot = process.cwd()
    const pkg = loadBasePackage(repoRoot)
    const stamp = readStamp(agentDir)
    const surface = stamp?.surface ?? 'team'
    validateSelection(pkg, { surface, packs: [...(stamp?.packs ?? []), pack] })
    const entries = {
      plugins: pkg.manifest.plugins.filter((e) => e.pack === pack),
      skills: pkg.manifest.skills.filter((e) => e.pack === pack),
      hooks: pkg.manifest.hooks.filter((e) => e.pack === pack),
    }
    const results = await installArtifacts(agentDir, entries, repoRoot, {
      gitToken: process.env.ARTIFACT_GIT_TOKEN || process.env.GITHUB_TOKEN || undefined,
    })
    const failed = results.filter((r) => !r.installed)
    if (failed.length) {
      return { pack, installed: false, error: failed.map((r) => `${r.type}/${r.name}: ${r.error}`).join('; ') }
    }
    const configPath = path.join(agentDir, 'config.yaml')
    const names = entries.plugins.filter((p) => p.enabled).map((p) => p.name)
    const config = fs.readFileSync(configPath, 'utf-8')
    const { content, added } = ensurePluginsEnabled(config, names)
    if (content !== config) fs.writeFileSync(configPath, content, 'utf-8')
    if (stamp && !stamp.packs.includes(pack)) {
      fs.writeFileSync(
        path.join(agentDir, STAMP_FILE),
        JSON.stringify({ ...stamp, packs: [...stamp.packs, pack] }, null, 2) + '\n',
      )
    }
    services.audit.append({ who: 'admin', what: `pack:install:${pack}`, target: harness.name })
    return { pack, installed: true, pluginsEnabled: added }
  } catch (err) {
    return { pack, installed: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function pluginInstalled(agentName: string, plugin: string): boolean {
  return fs.existsSync(path.join(agentDataDirForName(agentName), 'plugins', plugin, 'plugin.yaml'))
}

// --- audit cache (filled by the 6-hourly timer) ------------------------------

export function cachedAudit(harnessId: string): AuditSummary | null {
  return services.storage.read<Record<string, AuditSummary>>(AUDIT_FILE, {})[harnessId] ?? null
}

export async function refreshAudit(harness: Harness): Promise<AuditSummary> {
  const summary = await auditCheck(harness.name)
  const all = services.storage.read<Record<string, AuditSummary>>(AUDIT_FILE, {})
  all[harness.id] = summary
  services.storage.write(AUDIT_FILE, all)
  return summary
}

// --- status and the settings change -----------------------------------------

export async function protectedOutputsStatus(harnessId: string): Promise<ProtectedOutputsStatus | undefined> {
  const h = services.harness.get(harnessId)
  if (!h) return undefined
  const s = h.ovenmitt
  return {
    enabled: s?.enabled === true,
    destinations: s?.destinations ?? [],
    ttl: s?.ttl ?? DEFAULT_TTL,
    liveSurfaces: liveSurfaces(h.name),
    credentialIssued: storedCredential(h.id) !== null,
    ...(s?.credentialId ? { credentialId: s.credentialId } : {}),
    daemon: s?.enabled ? await daemonHealth(h.name) : 'absent',
    composeManaged: fs.existsSync(swarmMapComposePath(dataDir(), h.name)),
    pluginInstalled: pluginInstalled(h.name, BRIDGE_PLUGIN),
    audit: cachedAudit(h.id),
  }
}

const inFlight = new Set<string>()

export type SetResult =
  | { ok: true; status: ProtectedOutputsStatus; restarted: boolean; pack?: PackResult }
  | Fail

/**
 * Apply a Protected outputs change: { enabled?, destinations?, ttl? }.
 * Enabling on an enabled agent with new destinations/TTL only reconfigures
 * the daemon.
 */
export async function setProtectedOutputs(
  harnessId: string,
  body: { enabled?: unknown; destinations?: unknown; ttl?: unknown },
): Promise<SetResult> {
  const h = services.harness.get(harnessId)
  if (!h) return { ok: false, status: 404, error: 'Harness not found' }
  if (h.runtime !== 'hermes') return { ok: false, status: 400, error: 'Protected outputs needs a Hermes agent' }
  const invalid = validateOvenmitt(body)
  if (invalid) return { ok: false, status: 400, error: invalid }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return { ok: false, status: 400, error: 'enabled must be true or false' }
  }
  const file = swarmMapComposePath(dataDir(), h.name)
  if (!fs.existsSync(file)) {
    return {
      ok: false,
      status: 409,
      error: `Protected outputs needs a compose file Swarm Map wrote; ${h.name} has none at ${file}. See docs/runbooks/ovenmitt.md.`,
    }
  }
  if (inFlight.has(harnessId)) return { ok: false, status: 409, error: 'A Protected outputs change is already in progress' }
  inFlight.add(harnessId)
  try {
    const enabled = body.enabled === undefined ? h.ovenmitt?.enabled === true : body.enabled
    const want = {
      destinations: (body.destinations as string[] | undefined) ?? h.ovenmitt?.destinations ?? [],
      ttl: (body.ttl as string | undefined) ?? h.ovenmitt?.ttl ?? DEFAULT_TTL,
    }
    if (!enabled) {
      if (h.transcription?.enabled) {
        return { ok: false, status: 409, error: 'Turn off Transcription first: it depends on Protected outputs' }
      }
      const restarted = await disable(h, file, want)
      return { ok: true, status: (await protectedOutputsStatus(harnessId))!, restarted }
    }
    // The plugin first: enable() renders the credential only once the plugin
    // that pops it is installed and enabled.
    const pack = pluginInstalled(h.name, BRIDGE_PLUGIN) ? undefined : await installPack(h, PROTECTED_OUTPUTS_PACK)
    const restarted = await enable(h, file, want)
    if (pack?.installed && !restarted) services.harness.restart(harnessId, 'recreate')
    return { ok: true, status: (await protectedOutputsStatus(harnessId))!, restarted: restarted || pack?.installed === true, ...(pack ? { pack } : {}) }
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) }
  } finally {
    inFlight.delete(harnessId)
  }
}

async function enable(h: Harness, file: string, want: { destinations: string[]; ttl: string }): Promise<boolean> {
  const cfgPath = ovenmittConfigPath(dataDir(), h.name)
  const composeBefore = fs.readFileSync(file, 'utf-8')
  const tomlBefore = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf-8') : null
  const overlayBefore = h.ovenmitt
  const wasEnabled = overlayBefore?.enabled === true
  let issued: { id: string; token: string } | null = null
  try {
    const toml = renderOvenmittToml(want)
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
    fs.writeFileSync(cfgPath, toml, { mode: 0o644 })
    const withSidecar = applyOvenmitt(composeBefore, h.name, { image: ovenmittImage(), configPath: cfgPath })
    if (withSidecar !== composeBefore) writeComposeSecret(file, withSidecar)
    await startSidecar(file, h.name, tomlBefore !== null && tomlBefore !== toml)

    let credentialId = overlayBefore?.credentialId
    if (!storedCredential(h.id)) {
      issued = await issueCredential(h.name)
      storeCredential(h.id, issued.token)
      credentialId = issued.id
    }
    const settings: OvenmittSettings = {
      enabled: true,
      destinations: want.destinations,
      ttl: want.ttl,
      ...(credentialId ? { credentialId } : {}),
    }
    services.harness.updateConfig(h.id, { ovenmitt: settings })
    const wired = setManagedEnv(fs.readFileSync(file, 'utf-8'), h.name, managedEnvFor({ ...h, ovenmitt: settings }))
    writeComposeSecret(file, wired)
    services.audit.append({
      who: 'admin',
      what: wasEnabled ? 'protected-outputs:update' : 'protected-outputs:enable',
      target: h.name,
      meta: { destinations: want.destinations, ttl: want.ttl },
    })
    // A destination/TTL change is the daemon's business alone; only the
    // first enable (new mount, new environment) needs the agent recreated.
    if (wired === composeBefore || (wasEnabled && !issued)) return false
    services.harness.restart(h.id, 'recreate')
    return true
  } catch (err) {
    writeComposeSecret(file, composeBefore)
    if (tomlBefore === null) fs.rmSync(cfgPath, { force: true })
    else fs.writeFileSync(cfgPath, tomlBefore, { mode: 0o644 })
    services.harness.updateConfig(h.id, { ovenmitt: overlayBefore })
    if (issued) {
      storeCredential(h.id, null)
      await revokeCredential(h.name, issued.id).catch(() => false)
    }
    if (!wasEnabled) await removeSidecar(h.name)
    throw err
  }
}

async function disable(h: Harness, file: string, want: { destinations: string[]; ttl: string }): Promise<boolean> {
  if (h.ovenmitt?.credentialId) await revokeCredential(h.name, h.ovenmitt.credentialId).catch(() => false)
  storeCredential(h.id, null)
  const settings: OvenmittSettings = { enabled: false, destinations: want.destinations, ttl: want.ttl }
  services.harness.updateConfig(h.id, { ovenmitt: settings })
  const before = fs.readFileSync(file, 'utf-8')
  const after = setManagedEnv(removeOvenmitt(before, h.name), h.name, managedEnvFor({ ...h, ovenmitt: settings }))
  if (after !== before) writeComposeSecret(file, after)
  await removeSidecar(h.name)
  services.audit.append({ who: 'admin', what: 'protected-outputs:disable', target: h.name })
  if (after === before) return false
  services.harness.restart(h.id, 'recreate')
  return true
}
