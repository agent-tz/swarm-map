/**
 * ovenmitt: the per-agent vault daemon behind Protected outputs.
 *
 * This module renders the daemon's operator config and talks to the running
 * sidecar (`docker exec ovenmitt-<name> ovenmitt …`). Every subprocess is an
 * argv array with no shell, like lib/services/docker.ts.
 *
 * Naming: an "ovenmitt vault" holds protected OUTPUTS (e.g. transcripts that
 * must never reach an LLM). It is not the key store, and API keys never go in
 * one.
 */

import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { SURFACE_SLUGS } from '@/lib/surfaces/registry'
import type { OvenmittVault } from '@/lib/types'
import { OVENMITT_SOCKET, ovenmittServiceName } from './ovenmitt-compose'

const execFileAsync = promisify(execFile)

/**
 * The daemon image. FIXME before this ships: pin the published image by tag
 * AND digest (ghcr.io/cyborg-garden/ovenmitt:<ver>@sha256:…, the camofox
 * lesson in #192). Until it is published, a locally built image is used;
 * OVENMITT_IMAGE on the Swarm Map server overrides.
 */
export const DEFAULT_OVENMITT_IMAGE = 'ovenmitt:latest'
export function ovenmittImage(): string {
  return process.env.OVENMITT_IMAGE || DEFAULT_OVENMITT_IMAGE
}

/** The vault older single-vault settings are migrated into. */
export const LEGACY_VAULT = 'private'
export const DEFAULT_TTL = '30d'
/** The `fs` destination a vault's location becomes. Not a platform slug. */
export const FOLDER_DESTINATION = 'folder'
/** Where a vault's location is mounted inside the daemon container. */
export const EXPORTS_DIR = '/var/lib/ovenmitt/exports'
const TTL = /^[1-9][0-9]{0,4}[smhd]$/
// The daemon's name grammar (vaults and destinations).
const VAULT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
// R-DST-6: a literal over [A-Za-z0-9:_./+-], optionally ending in /*.
const MATCH = /^[A-Za-z0-9:_.+-][A-Za-z0-9:_./+-]*(\/\*)?$/
// A host folder: absolute, no colon (compose volume syntax), no whitespace or quotes.
const HOST_PATH = /^\/[A-Za-z0-9._/-]+$/

export function ovenmittConfigPath(dataDir: string, agentName: string): string {
  return path.join(dataDir, 'compose', agentName, 'ovenmitt', 'ovenmitt.toml')
}

/** A platform's default target pattern: every chat on it. */
export function defaultMatch(platform: string): string {
  return `${platform}/*`
}

/**
 * Problems with requested vaults, or null. Checked before anything is
 * written, so only these shapes can reach the config file.
 */
export function validateVaults(vaults: unknown): string | null {
  if (!Array.isArray(vaults)) return 'vaults must be a list'
  const names = new Set<string>()
  for (const v of vaults as Record<string, unknown>[]) {
    if (!v || typeof v !== 'object') return 'each vault must be an object'
    if (typeof v.name !== 'string' || !VAULT_NAME.test(v.name)) {
      return `vault name ${JSON.stringify(v.name)} is invalid: lowercase letters, digits, - and _, starting with a letter or digit`
    }
    if (names.has(v.name)) return `vault ${v.name} is listed twice`
    names.add(v.name)
    if (typeof v.ttl !== 'string' || !TTL.test(v.ttl)) return `vault ${v.name}: ttl must look like 30d, 12h or 90m`
    if (!Array.isArray(v.destinations)) return `vault ${v.name}: destinations must be a list`
    const platforms = new Set<string>()
    for (const d of v.destinations as Record<string, unknown>[]) {
      const p = d?.platform
      if (typeof p !== 'string' || !(SURFACE_SLUGS as readonly string[]).includes(p)) {
        return `vault ${v.name}: unknown platform ${JSON.stringify(p)}`
      }
      if (platforms.has(p)) return `vault ${v.name}: ${p} is listed twice`
      platforms.add(p)
      const m = d.match
      // The bridge's target is `<platform>/<chat ref>`, so anything else never matches.
      if (typeof m !== 'string' || !MATCH.test(m) || !m.startsWith(`${p}/`) || m.length > 256) {
        return `vault ${v.name}: ${p} match must start with "${p}/" and use only letters, digits and : _ . / + - (optionally ending in /*)`
      }
    }
    if (v.location !== undefined) {
      const l = v.location as Record<string, unknown> | null
      if (!l || typeof l !== 'object') return `vault ${v.name}: location must be an object`
      if (typeof l.hostPath !== 'string' || !HOST_PATH.test(l.hostPath) || l.hostPath.split('/').includes('..')) {
        return `vault ${v.name}: folder must be an absolute path of letters, digits and . _ / -`
      }
      if (typeof l.overwrite !== 'boolean') return `vault ${v.name}: overwrite must be true or false`
    }
  }
  return null
}

/**
 * The operator config. Built only from validated vaults, so nothing typed
 * into a form reaches the file unchecked. Per vault: one `send` destination
 * per platform whose chats may receive its outputs, named after the platform
 * (the contract with the bridge plugin, which declares `<platform>/<chat ref>`
 * as its target), and an `fs` destination when it has a location.
 */
export function renderOvenmittToml(opts: { vaults: OvenmittVault[] }): string {
  const err = validateVaults(opts.vaults)
  if (err) throw new Error(err)
  const lines = [
    '# Generated by Swarm Map (Protected outputs). Edits here are overwritten.',
    '# The daemon reads this at start; the agent container never sees it.',
    '',
    '[daemon]',
    `socket             = "${OVENMITT_SOCKET}"`,
    '# The agent runs as a different uid than the daemon; the socket is the boundary.',
    'socket_mode        = "0666"',
    'data_dir           = "/var/lib/ovenmitt/data"',
    'keys_dir           = "/var/lib/ovenmitt/keys"',
    'audit_log          = "/var/lib/ovenmitt/audit/audit.jsonl"',
    'credentials        = "/var/lib/ovenmitt/data/credentials.toml"',
    'ttl_sweep_interval = "5m"',
  ]
  if (opts.vaults.length === 0) lines.push('', '# No vaults yet: every put is refused.')
  for (const v of [...opts.vaults].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push('', `[vault.${v.name}]`, 'expose_names    = false', `ttl             = "${v.ttl}"`, 'max_object_size = "64MiB"')
    for (const d of [...v.destinations].sort((a, b) => a.platform.localeCompare(b.platform))) {
      lines.push('', `[vault.${v.name}.destinations.${d.platform}]`, 'kind  = "send"', `match = "${d.match}"`)
    }
    if (v.location) {
      lines.push(
        '',
        `[vault.${v.name}.destinations.${FOLDER_DESTINATION}]`,
        'kind      = "fs"',
        `root      = "${EXPORTS_DIR}/${v.name}"`,
        `overwrite = ${v.location.overwrite}`,
      )
    }
    if (v.destinations.length === 0) {
      lines.push('', `# No chat may receive ${v.name}'s outputs yet: every send is refused (and audited).`)
    }
  }
  return lines.join('\n') + '\n'
}

type Run = { code: number; stdout: string; stderr: string }

async function run(argv: string[], timeoutMs = 60000): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', argv, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
    return { code: 0, stdout: stdout.toString(), stderr: stderr.toString() }
  } catch (err) {
    const e = err as { code?: unknown; stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? String(err),
    }
  }
}

export type DaemonHealth = 'healthy' | 'starting' | 'unhealthy' | 'absent'

export async function daemonHealth(agentName: string): Promise<DaemonHealth> {
  const r = await run(['inspect', ovenmittServiceName(agentName), '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'], 5000)
  if (r.code !== 0) return 'absent'
  const s = r.stdout.trim()
  return s === 'healthy' ? 'healthy' : s === 'starting' ? 'starting' : 'unhealthy'
}

/** Start (or update) the sidecar from the agent's compose and wait for its socket. */
export async function startSidecar(composeFile: string, agentName: string, recreate = false): Promise<void> {
  const svc = ovenmittServiceName(agentName)
  const argv = ['compose', '-f', composeFile, 'up', '-d', ...(recreate ? ['--force-recreate'] : []), svc]
  const up = await run(argv, 120000)
  if (up.code !== 0) throw new Error(`could not start ${svc}: ${up.stderr.trim().split('\n').pop()}`)
  for (let i = 0; i < 60; i++) {
    const h = await daemonHealth(agentName)
    if (h === 'healthy') return
    if (h === 'unhealthy' || h === 'absent') {
      const logs = await run(['logs', '--tail', '20', svc], 5000)
      throw new Error(`${svc} is ${h}: ${startupRefusal(logs.stdout + '\n' + logs.stderr)}`)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`${svc} did not become healthy within a minute`)
}

/**
 * Why the daemon wouldn't start, from its logs: its own "refusing to start"
 * line when there is one (e.g. a removed vault still holds objects), else the
 * last line.
 */
export function startupRefusal(logs: string): string {
  const lines = logs.split('\n').map((l) => l.trim()).filter(Boolean)
  const refusal = [...lines].reverse().find((l) => l.includes('refusing to start'))
  const line = refusal ?? lines.pop() ?? ''
  const vault = line.match(/belongs to vault "([a-z0-9_-]+)", which is not in the config/)
  if (vault) {
    return `the ${vault[1]} vault still holds objects, and the daemon won't start without it. Keep the vault until they are deleted or expire.`
  }
  return line
}

/** Stop and remove the sidecar container. Its volumes (the vault) stay. */
export async function removeSidecar(agentName: string): Promise<void> {
  await run(['rm', '-f', ovenmittServiceName(agentName)], 60000)
}

/**
 * Mint a consumer credential for the agent's bridge plugin. The daemon prints
 * the token once, to stdout, and keeps only its hash. No --vault: it covers
 * every vault, so adding a vault later needs no new credential.
 */
export async function issueCredential(agentName: string): Promise<{ id: string; token: string }> {
  const r = await run(['exec', ovenmittServiceName(agentName), 'ovenmitt', 'credential', 'issue', '--name', 'hermes-bridge'], 30000)
  const token = r.stdout.trim()
  const m = token.match(/^ovm_([0-9a-z]+)_[A-Za-z0-9_-]+$/)
  if (r.code !== 0 || !m) throw new Error(`credential issue failed: ${r.stderr.trim().split('\n').pop() ?? 'no token'}`)
  return { id: m[1], token }
}

export async function revokeCredential(agentName: string, id: string): Promise<boolean> {
  if (!/^[0-9a-z]+$/.test(id)) return false
  const r = await run(['exec', ovenmittServiceName(agentName), 'ovenmitt', 'credential', 'revoke', id], 30000)
  return r.code === 0
}

export type AuditSummary = {
  at: number
  ok: boolean // the hash chain verifies
  findings: number
  worst?: { severity: string; rule: string; summary: string }
  error?: string
}

const SEVERITY = ['low', 'medium', 'high', 'critical']

/** `audit verify` plus `audit review --since <window>`, summarised for the card. */
export async function auditCheck(agentName: string, since = '6h'): Promise<AuditSummary> {
  const svc = ovenmittServiceName(agentName)
  const at = Date.now()
  const verify = await run(['exec', svc, 'ovenmitt', 'audit', 'verify'], 60000)
  if (verify.code === 2 || verify.code === -1 || (verify.code !== 0 && verify.code !== 1)) {
    return { at, ok: false, findings: 0, error: (verify.stderr || verify.stdout).trim().split('\n').pop() }
  }
  // review exits 1 when it has findings at or above its threshold; that is
  // a result, not a failure.
  const review = await run(['exec', svc, 'ovenmitt', 'audit', 'review', '--since', since, '--json'], 60000)
  if (review.code !== 0 && review.code !== 1) {
    return { at, ok: verify.code === 0, findings: 0, error: review.stderr.trim().split('\n').pop() }
  }
  try {
    const report = JSON.parse(review.stdout.trim().split('\n').pop() || '{}') as {
      findings?: { severity: string; rule: string; summary: string }[]
    }
    const findings = report.findings ?? []
    const worst = [...findings].sort(
      (a, b) => SEVERITY.indexOf(b.severity.toLowerCase()) - SEVERITY.indexOf(a.severity.toLowerCase()),
    )[0]
    return {
      at,
      ok: verify.code === 0,
      findings: findings.length,
      ...(worst ? { worst: { severity: worst.severity.toLowerCase(), rule: worst.rule, summary: worst.summary } } : {}),
    }
  } catch {
    return { at, ok: verify.code === 0, findings: 0, error: 'unreadable review output' }
  }
}
