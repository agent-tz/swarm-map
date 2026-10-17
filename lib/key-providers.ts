// Single source of truth for the "add an API key" provider dropdown.
//
// This list used to be duplicated: one copy in app/(dashboard)/keys/page.tsx and
// a second, unrelated copy in app/(dashboard)/harnesses/[id]/page.tsx. They drifted
// in BOTH directions — the harness-scoped menu was missing `google` and `custom`,
// the global menu was missing the twelve service providers below `brave`. Anything
// added to only one menu is invisible from the other, so keep this the only copy.
//
// Not to be confused with MODEL_PROVIDERS in harnesses/[id]/page.tsx — that drives
// the model cascade editor (inference backends), not credential storage.
//
// Ordering is presentational: model/inference first, then platform/surface, then
// service APIs, with `custom` last as the escape hatch.
//
// `custom` is special on the write path: KeysService.resolveEnvVar has no
// PROVIDER_TO_VAR entry for it, so it resolves via the explicit `envVar` hint,
// else the key's name, else the useless CUSTOM_API_KEY fallback. Any form that
// offers `custom` must therefore also offer the env-var field.
//
// `bluesky` is a credential PAIR: the app password is the secret (→
// BLUESKY_APP_PASSWORD) and the account handle is non-secret config (→
// BLUESKY_IDENTIFIER, from the key's `identifier` field). Any form that offers
// `bluesky` must therefore also offer the identifier field.
export const KEY_PROVIDERS = [
  // Model / inference. `openrouter` maps to OPENROUTER_API_KEY on the write path
  // (see KeysService.resolveEnvVar) — the fleet's GLM-5.2 chat primary AND its
  // cheap-metered rung ([intelligent-routing-cost]) both ride OpenRouter, so
  // neither can be provisioned without it here.
  'anthropic', 'openai', 'google', 'google-cloud', 'openrouter', 'zai',
  'aws', 'aws-bedrock',
  // Platforms / surfaces
  'github', 'notion', 'telegram', 'signal', 'mattermost', 'bluesky',
  // Service APIs. `papareo` is sealed: see SEALED_PROVIDERS.
  'brave', 'helius', 'coingecko', 'dehashed', 'opencorporates',
  'capsolver', 'open-measures', 'pexels', 'papareo',
  // Escape hatch — requires the env-var field, see above.
  'custom',
]

// A provider may reach a form from outside the list (a ?request= prefill via
// lib/keys-request, or a key discovered from an existing .env). Appending it
// keeps the select from silently dropping the caller's choice.
export function providerOptions(current: string): string[] {
  return current && !KEY_PROVIDERS.includes(current)
    ? [...KEY_PROVIDERS, current]
    : KEY_PROVIDERS
}

// Sealed providers: their key never goes into the agent's .env, where the
// agent's own terminal tool could `cat` it. Assigning one renders it into the
// hermes service's compose `environment:` block instead (which outranks the
// .env), and the plugin that uses it pops it out of the process environment
// into memory at load. The residual (plaintext in the host compose file, 0600)
// is the same posture as .env. Fixed per provider in code: a second sealed
// provider is a one-line change when a need appears.
//
// papareo: Papa Reo outputs are licensed so that they must never reach an LLM
// provider, so the key that produces them must not be one `curl` away from the
// agent. See docs/runbooks/ovenmitt.md.
export const SEALED_PROVIDER_VARS: Readonly<Record<string, string>> = {
  papareo: 'PAPAREO_API_KEY',
}
export const SEALED_PROVIDERS: ReadonlySet<string> = new Set(Object.keys(SEALED_PROVIDER_VARS))

export function isSealedProvider(provider: string): boolean {
  return SEALED_PROVIDERS.has(provider)
}

/** True for a variable name a sealed provider owns, whatever key claims it. */
export function isSealedVar(varName: string): boolean {
  return Object.values(SEALED_PROVIDER_VARS).includes(varName)
}

// The plugin that pops each sealed provider's key at load. A sealed value is
// rendered into an agent's environment only while that plugin is installed
// and enabled there: with nothing to pop it, the value would sit in the
// gateway's environment for every terminal child to inherit.
export const SEALED_PROVIDER_CONSUMERS: Readonly<Record<string, string>> = {
  papareo: 'papareo_transcribe',
}
