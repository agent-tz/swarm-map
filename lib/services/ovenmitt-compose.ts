/**
 * Surgical compose edits for Protected outputs (the ovenmitt sidecar) and
 * sealed environment values.
 *
 * Every function here edits an EXISTING compose by line and is idempotent,
 * so one implementation serves all three lineages Swarm Map writes: the
 * standalone generator (plain and VPN) and the deploy-born generator
 * (read_only/tmpfs hardening). Regenerating a deploy-born compose would strip
 * that hardening, so nothing here ever regenerates; it refuses loudly when an
 * anchor it needs is missing (a hand-edited file), mirroring
 * addStateMigrationToCompose.
 *
 * The sidecar's socket is the ONLY thing of ovenmitt's the agent container
 * mounts. Data, keys, audit log and config stay in the sidecar: any of those
 * in the agent container would be a read path.
 */

import { assertNoNewline } from '@/lib/env-helpers'

/** Where the agent container sees the daemon's socket directory. */
export const OVENMITT_SOCKET_DIR = '/run/ovenmitt'
export const OVENMITT_SOCKET = `${OVENMITT_SOCKET_DIR}/ovenmitt.sock`

/**
 * Every name Swarm Map renders into the hermes service's `environment:` as a
 * managed (and mostly secret) value: the sealed provider keys plus the
 * ovenmitt wiring. extraEnv may not set any of them.
 */
export const MANAGED_ENV_NAMES = [
  'PAPAREO_API_KEY',
  'OVENMITT_CONSUMER_CREDENTIAL',
  'OVENMITT_SOCKET',
] as const

/**
 * The managed names whose values are secrets. s6-overlay copies every compose
 * `environment:` value into /run/s6/container_environment/, world-readable,
 * at each container start; the seal script locks these to root.
 */
export const SEALED_SECRET_NAMES = ['PAPAREO_API_KEY', 'OVENMITT_CONSUMER_CREDENTIAL'] as const

/** Where the seal script lands: s6-overlay runs /etc/cont-init.d as root before any service. */
export const SEAL_SCRIPT_TARGET = '/etc/cont-init.d/50-seal-secrets'

export function sealConfigName(agentName: string): string {
  return `seal-secrets-${agentName}`
}

export function ovenmittServiceName(agentName: string): string {
  // Must not start with hermes-/seraph-: discovery would claim it as an agent.
  return `ovenmitt-${agentName}`
}

/** The four named volumes, in declaration order. */
export function ovenmittVolumes(agentName: string): { data: string; keys: string; audit: string; sock: string } {
  return {
    data: `ovenmitt-data-${agentName}`,
    keys: `ovenmitt-keys-${agentName}`,
    audit: `ovenmitt-audit-${agentName}`,
    sock: `ovenmitt-sock-${agentName}`,
  }
}

export type OvenmittComposeOptions = {
  /** Daemon image, ideally pinned by tag and digest. */
  image: string
  /** Host path of the generated ovenmitt.toml (mounted read-only). */
  configPath: string
}

const refuse = (what: string, why: string): never => {
  throw new Error(`${what}: cannot edit compose (${why}) — refusing; edit the file manually`)
}

type Block = { start: number; end: number } // [start, end): header line .. first line after the block

/** A 2-space-indented service (or top-level-volume) entry and its body. */
function findEntry(lines: string[], header: string, from = 0, to = lines.length): Block | null {
  const start = lines.findIndex((l, i) => i >= from && i < to && l.trimEnd() === header)
  if (start < 0) return null
  let end = start + 1
  while (end < to && (lines[end].trim() === '' || /^ {4,}/.test(lines[end]))) end++
  // Trailing blank lines belong to whatever follows.
  while (end > start + 1 && lines[end - 1].trim() === '') end--
  return { start, end }
}

/** A column-0 key's block (e.g. `volumes:`), or null. */
function findTopLevel(lines: string[], key: string): Block | null {
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `) || l.startsWith(`${key}:\t`))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++
  while (end > start + 1 && lines[end - 1].trim() === '') end--
  return { start, end }
}

/** A 4-space key inside a service block, e.g. `    volumes:`. */
function findKey(lines: string[], block: Block, key: string): number {
  for (let i = block.start + 1; i < block.end; i++) {
    if (new RegExp(`^ {4}${key}:\\s*$`).test(lines[i])) return i
  }
  return -1
}

/** End (exclusive) of a 4-space key's nested body: lines indented 6+ (items, comments). */
function keyBodyEnd(lines: string[], keyIdx: number, block: Block): number {
  let end = keyIdx + 1
  while (end < block.end && /^ {6,}\S/.test(lines[end])) end++
  return end
}

function hermesBlock(lines: string[], agentName: string, what: string): Block {
  const block = findEntry(lines, `  hermes-${agentName}:`)
  if (!block) return refuse(what, `no "hermes-${agentName}" service found`)
  return block
}

function sidecarBlock(agentName: string, opts: OvenmittComposeOptions): string[] {
  const v = ovenmittVolumes(agentName)
  return [
    `  ${ovenmittServiceName(agentName)}:`,
    `    image: ${opts.image}`,
    `    container_name: ${ovenmittServiceName(agentName)}`,
    `    restart: unless-stopped`,
    `    # The vault daemon needs no network at all, in plain and VPN mode alike.`,
    `    network_mode: none`,
    `    read_only: true`,
    `    cap_drop:`,
    `      - ALL`,
    `    security_opt:`,
    `      - no-new-privileges:true`,
    `    volumes:`,
    `      - ${v.data}:/var/lib/ovenmitt/data`,
    `      # Back this one up separately from the data volume: losing it loses every vault.`,
    `      - ${v.keys}:/var/lib/ovenmitt/keys`,
    `      - ${v.audit}:/var/lib/ovenmitt/audit`,
    `      - ${v.sock}:${OVENMITT_SOCKET_DIR}`,
    `      - ${opts.configPath}:/etc/ovenmitt/ovenmitt.toml:ro`,
    `    healthcheck:`,
    `      test: ["CMD-SHELL", "test -S ${OVENMITT_SOCKET}"]`,
    `      interval: 5s`,
    `      timeout: 3s`,
    `      retries: 12`,
  ]
}

/**
 * Add (or refresh) the ovenmitt sidecar: the service, the socket mount and a
 * health gate on the hermes service, and the four named volumes. Applying
 * twice with the same options is a no-op.
 */
export function applyOvenmitt(compose: string, agentName: string, opts: OvenmittComposeOptions): string {
  const what = 'protected-outputs'
  assertNoNewline(opts.image, 'ovenmitt image')
  assertNoNewline(opts.configPath, 'ovenmitt config path')
  if (!opts.configPath.startsWith('/') || opts.configPath.includes(':')) {
    refuse(what, `config path must be absolute and colon-free: ${opts.configPath}`)
  }
  const lines = removeOvenmitt(compose, agentName).split('\n')
  const svc = ovenmittServiceName(agentName)
  const v = ovenmittVolumes(agentName)

  let hermes = hermesBlock(lines, agentName, what)

  // 1. hermes volumes: the socket directory, nothing else.
  const volIdx = findKey(lines, hermes, 'volumes')
  if (volIdx < 0) refuse(what, 'hermes service has no volumes: key')
  lines.splice(keyBodyEnd(lines, volIdx, hermes), 0, `      - ${v.sock}:${OVENMITT_SOCKET_DIR}`)
  hermes = hermesBlock(lines, agentName, what)

  // 2. depends_on: map form (compose can't mix list and map forms).
  const gate = [`      ${svc}:`, '        condition: service_healthy']
  const depIdx = findKey(lines, hermes, 'depends_on')
  if (depIdx >= 0) {
    const end = keyBodyEnd(lines, depIdx, hermes)
    const body = lines.slice(depIdx + 1, end).flatMap((l) => {
      const item = l.match(/^ {6}- (\S+)\s*$/)
      return item ? [`      ${item[1]}:`, '        condition: service_started'] : [l]
    })
    lines.splice(depIdx + 1, end - depIdx - 1, ...body, ...gate)
  } else {
    // Right after the image/build source block, where the generators put it.
    let at = hermes.start + 2
    while (at < hermes.end && /^ {6,}\S/.test(lines[at])) at++
    lines.splice(at, 0, '    depends_on:', ...gate)
  }

  // 3. the sidecar service, as a sibling right before the hermes service.
  hermes = hermesBlock(lines, agentName, what)
  lines.splice(hermes.start, 0, ...sidecarBlock(agentName, opts))

  // 4. top-level volumes, each with a pinned name (no project-name prefix).
  const decl = [v.data, v.keys, v.audit, v.sock].flatMap((n) => [`  ${n}:`, `    name: ${n}`])
  const top = findTopLevel(lines, 'volumes')
  if (top) {
    if (lines[top.start] !== 'volumes:') refuse(what, 'top-level volumes: is not a block mapping')
    lines.splice(top.end, 0, ...decl)
  } else {
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines.push('', 'volumes:', ...decl, '')
  }
  return lines.join('\n')
}

/** Remove everything applyOvenmitt adds. Volumes (and so the vault) are kept on disk. */
export function removeOvenmitt(compose: string, agentName: string): string {
  const lines = compose.split('\n')
  const svc = ovenmittServiceName(agentName)
  const v = ovenmittVolumes(agentName)

  const side = findEntry(lines, `  ${svc}:`)
  if (side) lines.splice(side.start, side.end - side.start)

  const hermes = findEntry(lines, `  hermes-${agentName}:`)
  if (hermes) {
    const sockLine = lines.findIndex(
      (l, i) => i > hermes.start && i < hermes.end && l.trim() === `- ${v.sock}:${OVENMITT_SOCKET_DIR}`,
    )
    if (sockLine >= 0) lines.splice(sockLine, 1)
    const h2 = findEntry(lines, `  hermes-${agentName}:`)!
    const gate = lines.findIndex((l, i) => i > h2.start && i < h2.end && l === `      ${svc}:`)
    if (gate >= 0) {
      const n = lines[gate + 1]?.startsWith('        condition:') ? 2 : 1
      lines.splice(gate, n)
      const h3 = findEntry(lines, `  hermes-${agentName}:`)!
      const depIdx = findKey(lines, h3, 'depends_on')
      if (depIdx >= 0 && keyBodyEnd(lines, depIdx, h3) === depIdx + 1) lines.splice(depIdx, 1)
    }
  }

  const top = findTopLevel(lines, 'volumes')
  if (top) {
    for (const name of [v.data, v.keys, v.audit, v.sock]) {
      const entry = findEntry(lines, `  ${name}:`, top.start, findTopLevel(lines, 'volumes')!.end)
      if (entry) lines.splice(entry.start, entry.end - entry.start)
    }
    const after = findTopLevel(lines, 'volumes')!
    if (after.end === after.start + 1) {
      // An emptied volumes: block would parse as null; drop it and its spacer.
      lines.splice(after.start, 1)
      if (after.start > 0 && lines[after.start - 1] === '') lines.splice(after.start - 1, 1)
    }
  }
  return lines.join('\n')
}

export function hasOvenmitt(compose: string, agentName: string): boolean {
  return compose.split('\n').some((l) => l.trimEnd() === `  ${ovenmittServiceName(agentName)}:`)
}

/** YAML double-quoted list item `- "NAME=value"`, compose-interpolation safe. */
function envItem(name: string, value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name}: value contains a control character`)
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$')
  return `      - "${name}=${escaped}"`
}

/**
 * Set or clear entries in the hermes service's `environment:` list. A value
 * of null removes the entry. The block is created (after env_file) when it
 * doesn't exist yet: deploy-born composes have none. An `environment:` entry
 * outranks the agent's .env, which is why sealed values live here.
 */
export function setManagedEnv(compose: string, agentName: string, entries: Record<string, string | null>): string {
  const what = 'sealed env'
  const names = Object.keys(entries)
  for (const name of names) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`${what}: invalid variable name ${name}`)
  }
  const lines = compose.split('\n')
  let hermes = hermesBlock(lines, agentName, what)
  const isManaged = (l: string) =>
    names.some((n) => l.startsWith(`      - ${n}=`) || l.startsWith(`      - "${n}=`))

  let envIdx = findKey(lines, hermes, 'environment')
  if (envIdx >= 0) {
    for (let i = keyBodyEnd(lines, envIdx, hermes) - 1; i > envIdx; i--) {
      if (isManaged(lines[i])) lines.splice(i, 1)
    }
    hermes = hermesBlock(lines, agentName, what)
  }

  const add = names.filter((n) => entries[n] !== null).map((n) => envItem(n, entries[n] as string))
  if (add.length) {
    if (envIdx < 0) {
      const envFile = findKey(lines, hermes, 'env_file')
      if (envFile < 0) refuse(what, 'hermes service has neither environment: nor env_file:')
      envIdx = keyBodyEnd(lines, envFile, hermes)
      lines.splice(envIdx, 0, '    environment:')
      hermes = hermesBlock(lines, agentName, what)
    }
    lines.splice(keyBodyEnd(lines, envIdx, hermes), 0, ...add)
  } else if (envIdx >= 0 && keyBodyEnd(lines, envIdx, hermes) === envIdx + 1) {
    lines.splice(envIdx, 1) // an empty environment: would be null
  }
  return syncSealConfig(lines.join('\n'), agentName)
}

// --- the seal script -----------------------------------------------------------
//
// The plugins pop their secrets out of the gateway's environment at load, but
// s6-overlay has already written each one to /run/s6/container_environment/
// as a world-readable file, one `cat` away for the agent's terminal. The seal
// script, run by s6 as root from /etc/cont-init.d before any service starts,
// chmods those files to 0600. The gateway still receives the values: its run
// script reads them with `with-contenv` as root, then drops to the hermes
// user. The script travels inside the compose as an inline config (no host
// file to lose or mount), and is present exactly while a sealed value is.

function sealScript(): string[] {
  // Compose interpolates config content, so every shell `$` is written `$$`.
  return [
    '#!/bin/sh',
    '# Written by Swarm Map. Locks s6\'s copies of sealed values to root;',
    '# the gateway still gets them through with-contenv, run as root.',
    `for v in ${SEALED_SECRET_NAMES.join(' ')}; do`,
    '  f="/run/s6/container_environment/$$v"',
    '  if [ -e "$$f" ]; then chmod 600 "$$f"; fi',
    'done',
    'exit 0',
  ]
}

/** Remove the seal script's service mount and top-level config, if present. */
function removeSealConfig(lines: string[], agentName: string): void {
  const name = sealConfigName(agentName)
  const hermes = findEntry(lines, `  hermes-${agentName}:`)
  if (hermes) {
    const item = lines.findIndex((l, i) => i > hermes.start && i < hermes.end && l === `      - source: ${name}`)
    if (item >= 0) {
      let end = item + 1
      while (end < hermes.end && /^ {8,}\S/.test(lines[end])) end++
      lines.splice(item, end - item)
      const h2 = findEntry(lines, `  hermes-${agentName}:`)!
      const cfgIdx = findKey(lines, h2, 'configs')
      if (cfgIdx >= 0 && keyBodyEnd(lines, cfgIdx, h2) === cfgIdx + 1) lines.splice(cfgIdx, 1)
    }
  }
  const top = findTopLevel(lines, 'configs')
  if (top) {
    const entry = findEntry(lines, `  ${name}:`, top.start, top.end)
    if (entry) lines.splice(entry.start, entry.end - entry.start)
    const after = findTopLevel(lines, 'configs')!
    if (after.end === after.start + 1) {
      lines.splice(after.start, 1)
      if (after.start > 0 && lines[after.start - 1] === '') lines.splice(after.start - 1, 1)
    }
  }
}

/**
 * Make the seal script's presence match the compose: mounted while the hermes
 * service's environment holds any sealed value, gone otherwise. Idempotent.
 */
export function syncSealConfig(compose: string, agentName: string): string {
  const what = 'sealed env'
  const lines = compose.split('\n')
  removeSealConfig(lines, agentName)
  let hermes = hermesBlock(lines, agentName, what)
  const envIdx = findKey(lines, hermes, 'environment')
  const sealed =
    envIdx >= 0 &&
    lines
      .slice(envIdx + 1, keyBodyEnd(lines, envIdx, hermes))
      .some((l) => SEALED_SECRET_NAMES.some((n) => l.startsWith(`      - ${n}=`) || l.startsWith(`      - "${n}=`)))
  if (!sealed) return lines.join('\n')

  const name = sealConfigName(agentName)
  const mount = [`      - source: ${name}`, `        target: ${SEAL_SCRIPT_TARGET}`, '        mode: 0555']
  const cfgIdx = findKey(lines, hermes, 'configs')
  if (cfgIdx >= 0) {
    lines.splice(keyBodyEnd(lines, cfgIdx, hermes), 0, ...mount)
  } else {
    lines.splice(keyBodyEnd(lines, envIdx, hermes), 0, '    configs:', ...mount)
  }
  hermes = hermesBlock(lines, agentName, what)

  const decl = [`  ${name}:`, '    content: |', ...sealScript().map((l) => `      ${l}`)]
  const top = findTopLevel(lines, 'configs')
  if (top) {
    if (lines[top.start] !== 'configs:') refuse(what, 'top-level configs: is not a block mapping')
    lines.splice(top.end, 0, ...decl)
  } else {
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines.push('', 'configs:', ...decl, '')
  }
  return lines.join('\n')
}

/** Read the hermes service's memory limit (`deploy.resources.limits.memory`). */
export function readComposeMemory(compose: string, agentName: string): string | null {
  const lines = compose.split('\n')
  const hermes = findEntry(lines, `  hermes-${agentName}:`)
  if (!hermes) return null
  for (let i = hermes.start; i < hermes.end; i++) {
    const m = lines[i].match(/^ {10}memory:\s*(\S+)\s*$/)
    if (m) return m[1]
  }
  return null
}

/** Rewrite the hermes service's memory limit in place. */
export function setComposeMemory(compose: string, agentName: string, memory: string): string {
  const what = 'memory limit'
  if (!/^\d+(\.\d+)?[kKmMgG]?$/.test(memory)) throw new Error(`${what}: invalid memory value ${memory}`)
  const lines = compose.split('\n')
  const hermes = hermesBlock(lines, agentName, what)
  for (let i = hermes.start; i < hermes.end; i++) {
    if (/^ {10}memory:\s*\S+\s*$/.test(lines[i])) {
      lines[i] = `          memory: ${memory}`
      return lines.join('\n')
    }
  }
  return refuse(what, 'hermes service has no deploy.resources.limits.memory')
}

/** Compose memory strings to bytes, for "raise unless already higher". */
export function memoryBytes(memory: string): number {
  const m = memory.match(/^(\d+(?:\.\d+)?)([kKmMgG]?)$/)
  if (!m) return NaN
  const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g']
  return parseFloat(m[1]) * unit
}
