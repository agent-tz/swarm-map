import { NextResponse } from 'next/server'
import { setTranscription, transcriptionStatus } from '@/lib/services/transcription'

/**
 * GET /api/harnesses/:id/transcription
 *
 * Transcription (Papa Reo escalation) status: enabled, whether Protected
 * outputs is on (required), whether a Papa Reo key is assigned, whether the
 * plugin is installed, and the agent's memory limit.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const status = transcriptionStatus(id)
  if (!status) return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  return NextResponse.json(status)
}

/**
 * PUT /api/harnesses/:id/transcription
 *
 * Body: `{ enabled: boolean }`. Enabling turns voice input off (voice notes
 * reach the agent as recordings), sets the local whisper model, raises
 * memory to 3G unless it is already higher, installs the transcription pack
 * and recreates the agent. Disabling puts back what enabling replaced.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  let body: { enabled?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const r = await setTranscription(id, body ?? {})
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, restarted: r.restarted, status: r.status, ...(r.pack ? { pack: r.pack } : {}) })
}
