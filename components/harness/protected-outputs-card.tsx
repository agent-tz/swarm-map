// components/harness/protected-outputs-card.tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AudioLines, Loader2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { SURFACES, isSurfaceSlug } from '@/lib/surfaces/registry'
import type { ProtectedOutputsStatus } from '@/lib/services/protected-outputs'
import type { TranscriptionStatus } from '@/lib/services/transcription'

type Props = { harnessId: string }

// Platforms whose suitability as a destination for licensed outputs is not
// settled. Ticking one is allowed, but the operator is told why it is doubtful.
const CAUTION: Record<string, string> = {
  discord:
    'Discord can read message content and attachments. Not a destination for Papa Reo output until Te Hiku Media clears it.',
}

function label(slug: string): string {
  return isSurfaceSlug(slug) ? SURFACES[slug].label : slug
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
 * "Protected outputs": the agent's ovenmitt vault. Outputs that must never
 * enter an LLM's context go into the vault, and only reach chats on the
 * platforms ticked here.
 */
export function ProtectedOutputsCard({ harnessId }: Props) {
  const [status, setStatus] = useState<ProtectedOutputsStatus | null>(null)
  const [busy, setBusy] = useState(false)

  function load() {
    fetch(`/api/harnesses/${harnessId}/protected-outputs`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setStatus(d))
      .catch(() => setStatus(null))
  }
  useEffect(load, [harnessId])
  if (!status) return null

  async function save(body: { enabled?: boolean; destinations?: string[] }) {
    setBusy(true)
    const { ok, data } = await put(`/api/harnesses/${harnessId}/protected-outputs`, body)
    setBusy(false)
    if (!ok) {
      toast.error(data.error || 'Failed to save')
    } else {
      toast.success(data.restarted ? 'Saved — the agent is restarting.' : 'Saved.')
      reportPack(data)
    }
    load()
  }

  const candidates = Array.from(new Set([...status.liveSurfaces, ...status.destinations]))
  const toggleDestination = (slug: string, on: boolean) =>
    save({ destinations: on ? [...status.destinations, slug] : status.destinations.filter((d) => d !== slug) })

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium text-sm flex-1">Protected outputs</h3>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <Switch
          checked={status.enabled}
          onCheckedChange={(v) => save({ enabled: v })}
          disabled={busy || !status.composeManaged}
          aria-label="Protected outputs"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        An ovenmitt vault for outputs that must never enter the model&apos;s context. The agent holds them by handle,
        can send them to the chat it is talking to, and cannot read them. Not the key store: API keys never go here.
      </p>
      {!status.composeManaged && (
        <p className="text-xs text-[var(--warning)]">
          This agent&apos;s compose file was not written by Swarm Map, so this can&apos;t be turned on here.
        </p>
      )}
      {status.enabled && (
        <>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Chats that may receive protected files (default none):</p>
            {candidates.length === 0 && <p className="text-xs text-muted-foreground">No platform is connected yet.</p>}
            {candidates.map((slug) => (
              <label key={slug} className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--accent)]"
                  checked={status.destinations.includes(slug)}
                  disabled={busy}
                  onChange={(e) => toggleDestination(slug, e.target.checked)}
                />
                <span>
                  {label(slug)}
                  {CAUTION[slug] && <span className="block text-xs text-[var(--warning)]">{CAUTION[slug]}</span>}
                </span>
              </label>
            ))}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Daemon</dt>
            <dd>{status.daemon}</dd>
            <dt className="text-muted-foreground">Credential</dt>
            <dd>{status.credentialIssued ? `issued (${status.credentialId ?? '?'})` : 'not issued'}</dd>
            <dt className="text-muted-foreground">Bridge plugin</dt>
            <dd>{status.pluginInstalled ? 'installed' : 'not installed'}</dd>
            <dt className="text-muted-foreground">Kept for</dt>
            <dd>{status.ttl}</dd>
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

/**
 * "Transcription (Papa Reo escalation)": transcripts of recordings, sent to
 * Papa Reo when they may contain te reo Māori. Needs Protected outputs.
 */
export function TranscriptionCard({ harnessId }: Props) {
  const [status, setStatus] = useState<TranscriptionStatus | null>(null)
  const [busy, setBusy] = useState(false)

  function load() {
    fetch(`/api/harnesses/${harnessId}/transcription`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setStatus(d))
      .catch(() => setStatus(null))
  }
  useEffect(load, [harnessId])
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
    load()
  }

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
        Recordings people send get a transcript back as a file. English is transcribed locally; recordings that may
        contain te reo Māori go to Papa Reo, and the transcript goes through Protected outputs without the model
        reading it.
      </p>
      {!status.protectedOutputs && <p className="text-xs text-[var(--warning)]">Turn on Protected outputs first.</p>}
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
        <dd>{status.pluginInstalled ? 'installed' : 'not installed'}</dd>
        <dt className="text-muted-foreground">Memory limit</dt>
        <dd>{status.memory ?? 'unknown'}</dd>
      </dl>
      {status.enabled && (
        <p className="text-xs text-muted-foreground">
          Voice input is off on this agent: voice notes are treated as recordings to transcribe, not messages.
        </p>
      )}
    </div>
  )
}
