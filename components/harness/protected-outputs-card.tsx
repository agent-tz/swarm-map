// components/harness/protected-outputs-card.tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AudioLines, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SURFACES, isSurfaceSlug } from '@/lib/surfaces/registry'
import type { PluginVersion, ProtectedOutputsStatus } from '@/lib/services/protected-outputs'
import type { TranscriptionStatus } from '@/lib/services/transcription'
import type { OvenmittVault } from '@/lib/types'

type Props = { harnessId: string }

// Platforms whose suitability as a destination for licensed outputs is not
// settled. Ticking one is allowed, but the operator is told why it is doubtful.
const CAUTION: Record<string, string> = {}

/** "installed, v0.2.1", plus Swarm Map's pin when it differs or isn't known to match. */
function pluginLine(installed: boolean, v: PluginVersion): string {
  if (!installed) return v.pinned ? `not installed (Swarm Map pins ${v.pinned})` : 'not installed'
  if (!v.installed) return v.pinned ? `installed, tag not recorded (Swarm Map pins ${v.pinned})` : 'installed'
  if (v.pinned && v.pinned !== v.installed) return `installed, ${v.installed} (Swarm Map pins ${v.pinned}: update needed)`
  return `installed, ${v.installed}`
}

function label(slug: string): string {
  return isSurfaceSlug(slug) ? SURFACES[slug].label : slug
}

// The two cards depend on each other (Transcription needs Protected Outputs;
// Transcription adds the papareo vault), so a save on either reloads both.
const CHANGED = 'swarm-map:protected-outputs-changed'
function announceChange() {
  window.dispatchEvent(new Event(CHANGED))
}
function useReloadOnChange(load: () => void) {
  useEffect(() => {
    window.addEventListener(CHANGED, load)
    return () => window.removeEventListener(CHANGED, load)
  }, [load])
}

type SaveResponse = {
  error?: string
  restarted?: boolean
  pack?: { pack: string; installed: boolean; error?: string }
}

async function put(url: string, body: unknown): Promise<{ ok: boolean; data: SaveResponse }> {
  try {
    const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { ok: res.ok, data: await res.json() }
  } catch {
    return { ok: false, data: { error: 'Network error' } }
  }
}

function reportPack(data: SaveResponse) {
  if (data?.pack && !data.pack.installed) {
    toast.warning(`Saved, but the ${data.pack.pack} pack did not install: ${data.pack.error}`)
  }
}

/**
 * "Protected Outputs (oven-mitt)": the agent's ovenmitt vault daemon. Outputs
 * that must never enter an LLM's context go into a vault, and only reach the
 * chats ticked on that vault (or its export folder). No vault by default; a
 * feature that needs one (Transcription: "papareo") adds it.
 */
export function ProtectedOutputsCard({ harnessId }: Props) {
  const [status, setStatus] = useState<ProtectedOutputsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [newVault, setNewVault] = useState('')

  const load = useCallback(() => {
    fetch(`/api/harnesses/${harnessId}/protected-outputs`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setStatus(d))
      .catch(() => setStatus(null))
  }, [harnessId])
  useEffect(load, [load])
  useReloadOnChange(load)
  if (!status) return null

  async function save(body: { enabled?: boolean; vaults?: OvenmittVault[] }): Promise<boolean> {
    setBusy(true)
    const { ok, data } = await put(`/api/harnesses/${harnessId}/protected-outputs`, body)
    setBusy(false)
    if (!ok) {
      toast.error(data.error || 'Failed to save')
    } else {
      toast.success(data.restarted ? 'Saved — the agent is restarting.' : 'Saved.')
      reportPack(data)
    }
    announceChange()
    return ok
  }

  const vaults = status.vaults
  const saveVault = (next: OvenmittVault) => save({ vaults: vaults.map((v) => (v.name === next.name ? next : v)) })
  const removeVault = (name: string) => save({ vaults: vaults.filter((v) => v.name !== name) })
  async function addVault() {
    const name = newVault.trim()
    if (!name) return
    if (await save({ vaults: [...vaults, { name, ttl: status!.defaultTtl, destinations: [] }] })) setNewVault('')
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium text-sm flex-1">Protected Outputs (oven-mitt)</h3>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <Switch
          checked={status.enabled}
          onCheckedChange={(v) => save({ enabled: v })}
          disabled={busy || !status.composeManaged}
          aria-label="Protected Outputs (oven-mitt)"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Ovenmitt vaults for outputs that must never enter the model&apos;s context. The agent holds them by handle,
        can send them to the chat it is talking to, and cannot read them. Not the key store: API keys never go here.
      </p>
      {!status.composeManaged && (
        <p className="text-xs text-[var(--warning)]">
          This agent&apos;s compose file was not written by Swarm Map, so this can&apos;t be turned on here.
        </p>
      )}
      {status.enabled && (
        <>
          {vaults.length === 0 && (
            <p className="text-xs text-muted-foreground">No vaults yet. Add one, or turn on a feature that needs one.</p>
          )}
          {vaults.map((v) => (
            <VaultSection
              key={JSON.stringify(v)}
              vault={v}
              liveSurfaces={status.liveSurfaces}
              required={status.requiredVaults.includes(v.name)}
              busy={busy}
              onSave={saveVault}
              onRemove={() => removeVault(v.name)}
            />
          ))}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              addVault()
            }}
          >
            <Input
              className="h-7 text-xs font-mono flex-1"
              placeholder="new vault name, e.g. private"
              value={newVault}
              onChange={(e) => setNewVault(e.target.value.toLowerCase())}
              disabled={busy}
              aria-label="New vault name"
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy || !newVault.trim()}>
              <Plus /> Add vault
            </Button>
          </form>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Daemon</dt>
            <dd>{status.daemon}</dd>
            <dt className="text-muted-foreground">Credential</dt>
            <dd>{status.credentialIssued ? `issued (${status.credentialId ?? '?'})` : 'not issued'}</dd>
            <dt className="text-muted-foreground">Bridge plugin</dt>
            <dd>{pluginLine(status.pluginInstalled, status.pluginVersion)}</dd>
            <dt className="text-muted-foreground">Audit (last 6h)</dt>
            <dd>
              {status.audit === null
                ? 'not checked yet'
                : status.audit.error
                  ? `check failed: ${status.audit.error}`
                  : `${status.audit.ok ? 'chain ok' : 'CHAIN BROKEN'}, ${status.audit.findings} finding${status.audit.findings === 1 ? '' : 's'}${
                      status.audit.worst ? ` (worst: ${status.audit.worst.severity} ${status.audit.worst.rule})` : ''
                    }`}
            </dd>
          </dl>
        </>
      )}
    </div>
  )
}

type VaultSectionProps = {
  vault: OvenmittVault
  liveSurfaces: string[]
  required: boolean
  busy: boolean
  onSave: (v: OvenmittVault) => void
  onRemove: () => void
}

/** One vault: which chats may receive its outputs (with their match), and an optional export folder. */
function VaultSection({ vault, liveSurfaces, required, busy, onSave, onRemove }: VaultSectionProps) {
  const ticked = new Map(vault.destinations.map((d) => [d.platform, d.match]))
  const candidates = Array.from(new Set([...liveSurfaces, ...ticked.keys()]))
  // Drafts, so a half-typed match or path isn't saved on every keystroke.
  // The section is keyed by the saved vault, so a save resets them.
  const [matches, setMatches] = useState<Record<string, string>>({})
  const [folderOn, setFolderOn] = useState(!!vault.location)
  const [folder, setFolder] = useState(vault.location?.hostPath ?? '')
  // Two-step remove inline: window.confirm isn't reliable in embedded browsers.
  const [confirmRemove, setConfirmRemove] = useState(false)

  const matchFor = (slug: string) => matches[slug] ?? ticked.get(slug) ?? `${slug}/*`
  const withDestinations = (destinations: OvenmittVault['destinations']) => onSave({ ...vault, destinations })

  function toggle(slug: string, on: boolean) {
    const rest = vault.destinations.filter((d) => d.platform !== slug)
    withDestinations(on ? [...rest, { platform: slug, match: matchFor(slug) }] : rest)
  }
  function commitMatch(slug: string) {
    const m = matches[slug]
    if (m === undefined || !ticked.has(slug) || m === ticked.get(slug)) return
    withDestinations(vault.destinations.map((d) => (d.platform === slug ? { ...d, match: m.trim() } : d)))
  }
  function commitFolder(path: string, overwrite = vault.location?.overwrite ?? false) {
    const p = path.trim()
    if (!p || (p === vault.location?.hostPath && overwrite === vault.location?.overwrite)) return
    onSave({ ...vault, location: { hostPath: p, overwrite } })
  }
  function toggleFolder(on: boolean) {
    setFolderOn(on)
    if (!on && vault.location) {
      const next = { ...vault }
      delete next.location
      onSave(next)
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm flex-1">{vault.name}</span>
        <span className="text-xs text-muted-foreground">kept for {vault.ttl}</span>
        {required ? (
          <span className="text-xs text-muted-foreground">needed by Transcription</span>
        ) : confirmRemove ? (
          <>
            <Button size="xs" variant="destructive" onClick={onRemove} disabled={busy}>
              Remove
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(false)} disabled={busy}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setConfirmRemove(true)}
            disabled={busy}
            aria-label={`Remove the ${vault.name} vault`}
          >
            <Trash2 />
          </Button>
        )}
      </div>
      {confirmRemove && (
        <p className="text-xs text-[var(--warning)]">
          Objects already in {vault.name} stay on disk, encrypted, but can no longer be sent.
        </p>
      )}
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Chats that may receive outputs:</p>
        {candidates.length === 0 && <p className="text-xs text-muted-foreground">No platform is connected yet.</p>}
        {candidates.map((slug) => (
          <div key={slug} className="flex items-center gap-2 text-sm">
            <label className="flex items-center gap-2 cursor-pointer w-28 shrink-0">
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={ticked.has(slug)}
                disabled={busy}
                onChange={(e) => toggle(slug, e.target.checked)}
              />
              {label(slug)}
            </label>
            <Input
              className="h-7 text-xs font-mono"
              value={matchFor(slug)}
              disabled={busy}
              onChange={(e) => setMatches((m) => ({ ...m, [slug]: e.target.value }))}
              onBlur={() => commitMatch(slug)}
              onKeyDown={(e) => e.key === 'Enter' && commitMatch(slug)}
              aria-label={`${label(slug)} match`}
              title="Which chats on this platform: <platform>/* is every chat, or name one chat exactly"
            />
            {CAUTION[slug] && <span className="block text-xs text-[var(--warning)]">{CAUTION[slug]}</span>}
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="accent-[var(--accent)]"
            checked={folderOn}
            disabled={busy}
            onChange={(e) => toggleFolder(e.target.checked)}
          />
          Also allow exports to a folder
        </label>
        {folderOn && (
          <>
            <Input
              className="h-7 text-xs font-mono"
              placeholder="/absolute/path/on/this/machine"
              value={folder}
              disabled={busy}
              onChange={(e) => setFolder(e.target.value)}
              onBlur={() => commitFolder(folder)}
              onKeyDown={(e) => e.key === 'Enter' && commitFolder(folder)}
              aria-label={`${vault.name} export folder`}
            />
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={vault.location?.overwrite ?? false}
                disabled={busy || !vault.location}
                onChange={(e) => commitFolder(vault.location!.hostPath, e.target.checked)}
              />
              Overwrite files with the same name
            </label>
            <p className="text-xs text-muted-foreground">
              The folder must already exist. Only the vault daemon mounts it, never the agent, and files land there in
              plain text.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * "Transcription (Papa Reo escalation)": transcripts of recordings, sent to
 * Papa Reo when they may contain te reo Māori. Needs Protected outputs.
 */
export function TranscriptionCard({ harnessId }: Props) {
  const [status, setStatus] = useState<TranscriptionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [declaring, setDeclaring] = useState(false)

  const load = useCallback(() => {
    fetch(`/api/harnesses/${harnessId}/transcription`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setStatus(d))
      .catch(() => setStatus(null))
  }, [harnessId])
  useEffect(load, [load])
  useReloadOnChange(load)
  if (!status) return null

  async function save(enabled: boolean) {
    setBusy(true)
    const { ok, data } = await put(`/api/harnesses/${harnessId}/transcription`, { enabled })
    setBusy(false)
    if (!ok) toast.error(data.error || 'Failed to save')
    else {
      toast.success('Saved — the agent is restarting.')
      reportPack(data)
    }
    announceChange()
  }

  async function saveKaitiakitanga(on: boolean, confirm?: string): Promise<boolean> {
    setBusy(true)
    const { ok, data } = await put(`/api/harnesses/${harnessId}/transcription`, { kaitiakitanga: on, confirm })
    setBusy(false)
    if (!ok) toast.error(data.error || 'Failed to save')
    else toast.success(on ? 'Declared — the agent is restarting.' : 'Withdrawn — the agent is restarting.')
    announceChange()
    return ok
  }

  const k = status.kaitiakitanga

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <AudioLines className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium text-sm flex-1">Transcription (Papa Reo escalation)</h3>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <Switch
          checked={status.enabled}
          onCheckedChange={save}
          disabled={busy || (!status.enabled && !status.protectedOutputs)}
          aria-label="Transcription (Papa Reo escalation)"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Recordings people send get a transcript back as a file. The agent asks first: a local transcript (whisper,
        free), or Papa Reo for te reo Māori, whose transcript goes to the papareo vault without the model reading it.
        Switching this off and on also updates the plugin to the tag Swarm Map pins.
      </p>
      {!status.protectedOutputs && <p className="text-xs text-[var(--warning)]">Turn on Protected Outputs first.</p>}
      {status.enabled && !status.vault && (
        <p className="text-xs text-[var(--warning)]">
          There is no papareo vault for transcripts yet.{' '}
          <button className="underline" disabled={busy} onClick={() => save(true)}>
            Set it up
          </button>
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Papa Reo key</dt>
        <dd>
          {status.keyAssigned ? (
            'assigned (sealed)'
          ) : (
            <Link className="underline" href={`/keys?request=papareo&assign=${encodeURIComponent(harnessId)}`}>
              not assigned — request one
            </Link>
          )}
        </dd>
        <dt className="text-muted-foreground">Plugin</dt>
        <dd>{pluginLine(status.pluginInstalled, status.pluginVersion)}</dd>
        <dt className="text-muted-foreground">Memory limit</dt>
        <dd>{status.memory ?? 'unknown'}</dd>
      </dl>
      {status.enabled && (
        <p className="text-xs text-muted-foreground">
          Voice input is off on this agent: voice notes are treated as recordings to transcribe, not messages.
        </p>
      )}
      {status.enabled && (
        <div className="space-y-1 border-t border-[var(--border)] pt-3">
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--accent)]"
              checked={k.compliant}
              disabled={busy}
              onChange={(e) => (e.target.checked ? setDeclaring(true) : saveKaitiakitanga(false))}
            />
            <span>
              This agent is compliant with the{' '}
              <a className="underline" href="https://papareo.io/kaitiakitanga" target="_blank" rel="noreferrer">
                Kaitiakitanga License
              </a>
              <span className="block text-xs text-muted-foreground">
                Lets the agent read Papa Reo transcripts, and says so in its SOUL.md. Only for an agent whose models
                don&apos;t keep or learn from what they read.
              </span>
            </span>
          </label>
          {k.compliant && !k.declared && (
            <p className="text-xs text-[var(--warning)]">
              The declaration is missing from SOUL.md (edited away?). Untick and tick again to put it back.
            </p>
          )}
          {!k.compliant && k.remote.length > 0 && (
            <p className="text-xs text-[var(--warning)]">
              This agent sends model calls to remote hosts, so it is probably not compliant.
            </p>
          )}
        </div>
      )}
      <KaitiakitangaDialog
        open={declaring}
        status={k}
        busy={busy}
        onClose={() => setDeclaring(false)}
        onConfirm={async (confirm) => {
          if (await saveKaitiakitanga(true, confirm)) setDeclaring(false)
        }}
      />
    </div>
  )
}

const CONFIRM_PHRASE = 'I CONFIRM'

/**
 * Confirm before declaring an agent Kaitiakitanga-compliant, always. When
 * any configured model host is remote, the warning is loud and the operator
 * must type I CONFIRM (the server checks it too).
 */
function KaitiakitangaDialog({
  open,
  status,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean
  status: TranscriptionStatus['kaitiakitanga']
  busy: boolean
  onClose: () => void
  onConfirm: (confirm?: string) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (open) ref.current?.showModal()
    else ref.current?.close()
  }, [open])
  const remote = status.remote.length > 0
  const ready = !remote || typed.trim() === CONFIRM_PHRASE

  return (
    <dialog
      ref={ref}
      onClose={() => {
        setTyped('')
        onClose()
      }}
      className="backdrop:bg-black/50 rounded-xl border border-[var(--border)] bg-[var(--background)] p-6 w-full max-w-md shadow-xl space-y-3"
    >
      <h3 className="font-medium">Declare this agent Kaitiakitanga-compliant?</h3>
      <p className="text-sm text-muted-foreground">
        The{' '}
        <a className="underline" href="https://papareo.io/kaitiakitanga" target="_blank" rel="noreferrer">
          Kaitiakitanga License
        </a>{' '}
        forbids sending Papa Reo transcripts to services that may collect or use them. Once declared, this agent can
        read them, so every model it uses must be one that doesn&apos;t keep or learn from what it reads.
      </p>
      <div className="text-xs space-y-1">
        <p className="text-muted-foreground">Where this agent&apos;s model calls go:</p>
        <ul className="space-y-0.5">
          {status.hosts.map((h) => (
            <li key={h.role} className={h.local ? '' : 'text-[var(--danger)] font-medium'}>
              {h.local ? '✓' : '✗'} {h.role}: <span className="font-mono">{h.baseUrl ?? h.provider ?? 'unknown'}</span>{' '}
              <span className="text-muted-foreground">({h.why})</span>
            </li>
          ))}
        </ul>
        {status.hostedKeys.length > 0 && (
          <p className="text-[var(--warning)]">
            Keys for hosted providers are in this agent&apos;s .env ({status.hostedKeys.join(', ')}); a task left on
            &quot;auto&quot; might use one.
          </p>
        )}
        <p className="text-muted-foreground">
          This only reads the agent&apos;s config. A tool that calls a model on its own won&apos;t show here.
        </p>
      </div>
      {remote && (
        <div className="rounded-md border border-destructive bg-destructive/10 p-3 space-y-2">
          <p className="text-sm font-medium text-[var(--danger)]">
            This agent sends model calls to remote hosts. Declaring it compliant would very likely break the licence:
            Papa Reo transcripts would be sent to {status.remote.length === 1 ? 'that host' : 'those hosts'}.
          </p>
          <p className="text-xs">
            Type <span className="font-mono">{CONFIRM_PHRASE}</span> only if you know they don&apos;t keep or learn from
            what they read.
          </p>
          <Input
            className="h-8 font-mono"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={CONFIRM_PHRASE}
            aria-label="Type I CONFIRM"
          />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant={remote ? 'destructive' : 'default'}
          disabled={busy || !ready}
          onClick={() => onConfirm(remote ? CONFIRM_PHRASE : undefined)}
        >
          {busy && <Loader2 className="animate-spin" />} Declare compliant
        </Button>
      </div>
    </dialog>
  )
}
