import { describe, it, expect } from 'vitest'
import { isLocalUrl, modelHosting } from '../model-hosting'
import { spliceSoul } from '../transcription'

describe('isLocalUrl', () => {
  it('treats this machine, containers and private networks as local', () => {
    for (const u of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080',
      'http://host.docker.internal:11434/v1',
      'http://ollama:11434',
      'http://192.168.1.20:1234/v1',
      'http://10.0.0.5/v1',
      'http://172.20.0.2:8000',
      'http://studio.local:1234',
    ]) {
      expect(isLocalUrl(u), u).toBe(true)
    }
  })

  it('treats anything else as remote', () => {
    for (const u of ['https://api.anthropic.com', 'https://api.openai.com/v1', 'https://openrouter.ai/api/v1', 'http://172.32.0.1', 'not a url']) {
      expect(isLocalUrl(u), u).toBe(false)
    }
  })
})

describe('modelHosting', () => {
  it("reads lilly's shape: a local custom endpoint, compression on the same endpoint", () => {
    const config = [
      'model:',
      '  provider: custom',
      '  default: mlx-community/Qwen3.6-35B-A3B-4bit-DWQ',
      '  base_url: http://host.docker.internal:11434/v1',
      'auxiliary:',
      '  compression:',
      '    model: custom/mlx-community/Qwen3.6-35B-A3B-4bit-DWQ',
      '',
    ].join('\n')
    const r = modelHosting(config, 'DISCORD_BOT_TOKEN=x\n')
    expect(r.remote).toEqual([])
    expect(r.hosts.map((h) => h.role)).toEqual(['main model', 'auxiliary: compression'])
    expect(r.hostedKeys).toEqual([])
  })

  it('flags hosted providers, remote endpoints, fallbacks and hosted keys', () => {
    const config = [
      'model:',
      '  provider: openrouter',
      '  default: anthropic/claude-sonnet',
      'fallback_providers:',
      '  - provider: ollama',
      '    model: qwen',
      '  - provider: custom',
      '    model: x',
      '    base_url: "https://api.example.com/v1"',
      'auxiliary:',
      '  vision:',
      '    provider: auto',
      '  web_extract:',
      '    provider: anthropic',
      '',
    ].join('\n')
    const r = modelHosting(config, 'OPENROUTER_API_KEY=sk-x\nANTHROPIC_API_KEY=\n')
    expect(r.hosts.map((h) => [h.role, h.local])).toEqual([
      ['main model', false],
      ['fallback 1', true],
      ['fallback 2', false],
      ['auxiliary: web_extract', false],
    ])
    expect(r.remote).toHaveLength(3)
    expect(r.hostedKeys).toEqual(['OPENROUTER_API_KEY'])
  })

  it('cannot check a custom provider with no endpoint, so counts it as remote', () => {
    expect(modelHosting('model:\n  provider: custom\n').remote).toHaveLength(1)
  })
})

describe('spliceSoul', () => {
  const soul = '# lilly\n\nYou are lilly.\n'

  it('adds one marked block and removes exactly it', () => {
    const on = spliceSoul(soul, true)
    expect(on.startsWith(soul)).toBe(true)
    expect(on).toContain('Kaitiakitanga License (https://papareo.io/kaitiakitanga)')
    expect(spliceSoul(on, true)).toBe(on)
    expect(spliceSoul(on, false)).toBe(soul)
    expect(spliceSoul(soul, false)).toBe(soul)
  })

  it('leaves text the operator added after the block alone', () => {
    const on = spliceSoul(soul, true) + '\nAlso: be kind.\n'
    const off = spliceSoul(on, false)
    expect(off).toContain('You are lilly.')
    expect(off).toContain('Also: be kind.')
    expect(off).not.toContain('swarm-map:kaitiakitanga')
  })

  it('works on an empty SOUL.md', () => {
    const on = spliceSoul('', true)
    expect(spliceSoul(on, false)).toBe('')
  })
})
