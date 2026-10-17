import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { KeysService } from '../keys'
import { Storage } from '../storage'
import { AuditService } from '../audit'
import { generateAgentCompose } from '../agent-deploy-templates'
import { renderOvenmittToml, validateOvenmitt } from '../ovenmitt'
import { spliceStt } from '../transcription'
import { isSealedProvider, isSealedVar, KEY_PROVIDERS, SEALED_PROVIDER_CONSUMERS, SEALED_PROVIDER_VARS } from '@/lib/key-providers'
import { SEALED_SECRET_NAMES } from '../ovenmitt-compose'
import { pluginReady } from '../sealed-env'
import { RESERVED_EXTRA_ENV_NAMES, validateExtraEnv } from '../harness-compose'

describe('ovenmitt config', () => {
  it('declares no destination by default: every send is refused', () => {
    const toml = renderOvenmittToml({ destinations: [] })
    expect(toml).toContain('[vault.private]')
    expect(toml).toContain('ttl             = "30d"')
    expect(toml).toContain('expose_names    = false')
    expect(toml).not.toContain('kind  = "send"')
    expect(toml).toContain('socket_mode        = "0666"')
  })

  it('one send destination per platform, named after it, matching every chat on it', () => {
    const toml = renderOvenmittToml({ destinations: ['signal', 'discord', 'signal'], ttl: '7d' })
    expect(toml).toContain('[vault.private.destinations.signal]\nkind  = "send"\nmatch = "signal/*"')
    expect(toml).toContain('[vault.private.destinations.discord]\nkind  = "send"\nmatch = "discord/*"')
    expect(toml.match(/destinations\.signal\]/g)).toHaveLength(1)
    expect(toml).toContain('ttl             = "7d"')
  })

  it('accepts only registry platforms and a plain TTL', () => {
    expect(validateOvenmitt({ destinations: ['signal'] })).toBeNull()
    expect(validateOvenmitt({ destinations: ['signal"]\n[vault.x'] })).toMatch(/unknown platform/)
    expect(validateOvenmitt({ destinations: 'signal' })).toMatch(/list/)
    expect(validateOvenmitt({ ttl: '30d' })).toBeNull()
    expect(validateOvenmitt({ ttl: '30d"\nx' })).toMatch(/ttl/)
    expect(validateOvenmitt({ ttl: '0d' })).toMatch(/ttl/)
    expect(() => renderOvenmittToml({ destinations: ['nope'] })).toThrow()
  })
})

describe('spliceStt', () => {
  const LILLY_SHAPE = 'model:\n  provider: custom\nstt:\n  enabled: true\n  local:\n    model: base\ntts:\n  enabled: true\n'

  it('turns voice input off and sets the model, keeping the rest byte-identical', () => {
    const r = spliceStt(LILLY_SHAPE, { enabled: 'false', model: 'large-v3-turbo' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe('model:\n  provider: custom\nstt:\n  enabled: false\n  local:\n    model: large-v3-turbo\ntts:\n  enabled: true\n')
    expect(r.prior).toEqual({ enabled: 'true', model: 'base' })
  })

  it('puts back exactly what it replaced', () => {
    const on = spliceStt(LILLY_SHAPE, { enabled: 'false', model: 'large-v3-turbo' })
    if (!on.ok) throw new Error('splice failed')
    const off = spliceStt(on.text, { enabled: on.prior.enabled, model: on.prior.model })
    expect(off.ok && off.text).toBe(LILLY_SHAPE)
  })

  it('adds missing keys and a missing section, and removes what it added', () => {
    const base = 'model:\n  provider: x\n'
    const on = spliceStt(base, { enabled: 'false', model: 'large-v3-turbo' })
    if (!on.ok) throw new Error('splice failed')
    expect(on.text).toBe('model:\n  provider: x\nstt:\n  enabled: false\n  local:\n    model: large-v3-turbo\n')
    expect(on.prior).toEqual({ enabled: null, model: null })

    const partial = 'stt:\n  provider: local\ntts: {}\n'
    const p = spliceStt(partial, { enabled: 'false', model: 'large-v3-turbo' })
    expect(p.ok && p.text).toBe('stt:\n  enabled: false\n  provider: local\n  local:\n    model: large-v3-turbo\ntts: {}\n')
    if (!p.ok) return
    const back = spliceStt(p.text, { enabled: null, model: null })
    expect(back.ok && back.text).toBe('stt:\n  provider: local\n  local:\ntts: {}\n')
  })

  it('refuses shapes it cannot edit safely', () => {
    expect(spliceStt('stt: {enabled: true}\n', { enabled: 'false', model: null }).ok).toBe(false)
    expect(spliceStt('stt:\n  enabled: true\nstt:\n  enabled: false\n', { enabled: 'false', model: null }).ok).toBe(false)
  })
})

describe('sealed keys', () => {
  let tmpHome: string
  let tmpStore: string
  let prevHome: string | undefined
  let keys: KeysService
  const KEY = 'papareo-test-key-0123456789'
  const composeFile = () => path.join(tmpStore, 'compose', 'scout', 'docker-compose.yml')
  const envFile = () => path.join(tmpHome, '.hermes-scout', '.env')
  const agentDir = () => path.join(tmpHome, '.hermes-scout')
  // The consumer plugin, installed and enabled the way a pack leaves it.
  const installConsumer = (enabled = true) => {
    fs.mkdirSync(path.join(agentDir(), 'plugins', 'papareo_transcribe'), { recursive: true })
    fs.writeFileSync(path.join(agentDir(), 'plugins', 'papareo_transcribe', 'plugin.yaml'), 'name: papareo_transcribe\n')
    fs.writeFileSync(
      path.join(agentDir(), 'config.yaml'),
      enabled ? 'model: x\nplugins:\n  enabled:\n    - papareo_transcribe\n' : 'model: x\n',
    )
  }

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-sealed-home-'))
    tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-sealed-store-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    const storage = new Storage(tmpStore)
    keys = new KeysService(storage, new AuditService(storage), tmpStore)
    fs.mkdirSync(path.dirname(composeFile()), { recursive: true })
    fs.writeFileSync(composeFile(), generateAgentCompose('scout', 8642, path.join(tmpHome, '.hermes-scout'), { image: 'x' }))
    fs.mkdirSync(path.dirname(envFile()), { recursive: true })
    fs.writeFileSync(envFile(), `SIGNAL_ACCOUNT=+100\nPAPAREO_API_KEY=${KEY}\n`)
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpStore, { recursive: true, force: true })
  })

  it('papareo is a sealed provider offered on the Keys page', () => {
    expect(KEY_PROVIDERS).toContain('papareo')
    expect(isSealedProvider('papareo')).toBe(true)
    expect(isSealedProvider('github')).toBe(false)
  })

  it('assigning writes the compose environment, never the .env, and strips any .env copy', () => {
    installConsumer()
    expect(keys.writeKeyToEnv('h_scout', 'papareo', KEY)).toBe(true)
    const compose = fs.readFileSync(composeFile(), 'utf-8')
    expect(compose).toContain(`      - "PAPAREO_API_KEY=${KEY}"`)
    expect(fs.readFileSync(envFile(), 'utf-8')).toBe('SIGNAL_ACCOUNT=+100\n')
    expect(fs.statSync(composeFile()).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(composeFile())).mode & 0o777).toBe(0o700)
    // Idempotent.
    expect(keys.writeKeyToEnv('h_scout', 'papareo', KEY)).toBe(false)
  })

  it('unassigning clears it from the compose', () => {
    installConsumer()
    keys.writeKeyToEnv('h_scout', 'papareo', KEY)
    keys.removeKeyFromEnv('h_scout', 'papareo')
    expect(fs.readFileSync(composeFile(), 'utf-8')).not.toContain('PAPAREO_API_KEY')
  })

  it('refuses an agent without a Swarm-Map-written compose', () => {
    fs.rmSync(composeFile())
    expect(() => keys.writeKeyToEnv('h_scout', 'papareo', KEY)).toThrow(/compose file Swarm Map wrote/)
  })

  it('holds the key back until the plugin that pops it is installed and enabled', () => {
    for (const state of ['absent', 'disabled'] as const) {
      if (state === 'disabled') installConsumer(false)
      keys.writeKeyToEnv('h_scout', 'papareo', KEY)
      expect(fs.readFileSync(composeFile(), 'utf-8')).not.toContain(KEY)
      // The plaintext .env copy goes either way.
      expect(fs.readFileSync(envFile(), 'utf-8')).toBe('SIGNAL_ACCOUNT=+100\n')
    }
    installConsumer()
    expect(pluginReady(agentDir(), 'papareo_transcribe')).toBe(true)
    keys.writeKeyToEnv('h_scout', 'papareo', KEY)
    expect(fs.readFileSync(composeFile(), 'utf-8')).toContain(KEY)
  })

  it('a rendered secret brings the seal script; clearing it takes the script away', () => {
    installConsumer()
    keys.writeKeyToEnv('h_scout', 'papareo', KEY)
    const sealed = fs.readFileSync(composeFile(), 'utf-8')
    expect(sealed).toContain('      - source: seal-secrets-scout')
    expect(sealed).toContain('        target: /etc/cont-init.d/50-seal-secrets')
    expect(sealed).toMatch(/^configs:\n {2}seal-secrets-scout:\n {4}file: \.\/seal-secrets\.sh$/m)
    // The script sits beside the compose, executable, before the compose names it.
    const script = path.join(path.dirname(composeFile()), 'seal-secrets.sh')
    expect(fs.statSync(script).mode & 0o777).toBe(0o755)
    expect(fs.readFileSync(script, 'utf-8')).toContain('for v in PAPAREO_API_KEY OVENMITT_CONSUMER_CREDENTIAL; do')
    expect(fs.readFileSync(script, 'utf-8')).toContain('f="/run/s6/container_environment/$v"')
    keys.removeKeyFromEnv('h_scout', 'papareo')
    const cleared = fs.readFileSync(composeFile(), 'utf-8')
    expect(cleared).not.toContain('seal-secrets')
    expect(cleared).not.toMatch(/^configs:/m)
  })

  const registerScout = () => fs.writeFileSync(path.join(tmpStore, 'harnesses.json'), JSON.stringify([{ name: 'scout' }]))

  it('assigning moves a key discovered in the same agent\'s .env into the compose', () => {
    installConsumer()
    registerScout()
    const discovered = keys.list().find((k) => k.provider === 'papareo')!
    expect(discovered.assignedTo).toContain('h_scout')
    keys.setAssignment(discovered.id, ['h_scout'])
    expect(fs.readFileSync(envFile(), 'utf-8')).toBe('SIGNAL_ACCOUNT=+100\n')
    expect(fs.readFileSync(composeFile(), 'utf-8')).toContain(`      - "PAPAREO_API_KEY=${KEY}"`)
  })

  it('refuses an assignment without a Swarm-Map compose before saving anything', () => {
    registerScout()
    const discovered = keys.list().find((k) => k.provider === 'papareo')!
    fs.rmSync(composeFile())
    expect(() => keys.setAssignment(discovered.id, ['h_scout'])).toThrow(/compose file Swarm Map wrote/)
    const stored = fs.existsSync(path.join(tmpStore, 'keys.json')) ? fs.readFileSync(path.join(tmpStore, 'keys.json'), 'utf-8') : '[]'
    expect(stored).not.toContain(discovered.id)
  })

  it('no other key may claim a sealed variable', () => {
    expect(isSealedVar('PAPAREO_API_KEY')).toBe(true)
    expect(() => keys.add({ provider: 'custom', envVar: 'PAPAREO_API_KEY', value: 'zzz' } as never)).toThrow(/sealed provider/)
    expect(() => keys.writeKeyToEnv('h_scout', 'custom', 'zzz', { envVar: 'PAPAREO_API_KEY' })).toThrow(/sealed provider/)
  })

  it('every sealed variable is sealed in s6 and has a consumer plugin', () => {
    for (const [provider, varName] of Object.entries(SEALED_PROVIDER_VARS)) {
      expect(SEALED_SECRET_NAMES).toContain(varName)
      expect(SEALED_PROVIDER_CONSUMERS[provider]).toBeTruthy()
    }
    expect(SEALED_SECRET_NAMES).toContain('OVENMITT_CONSUMER_CREDENTIAL')
  })

  it('the managed names are reserved from extraEnv', () => {
    for (const n of ['PAPAREO_API_KEY', 'OVENMITT_CONSUMER_CREDENTIAL', 'OVENMITT_SOCKET']) {
      expect(RESERVED_EXTRA_ENV_NAMES.has(n)).toBe(true)
      expect(validateExtraEnv({ [n]: 'x' })).toMatch(/reserved/)
    }
  })
})
