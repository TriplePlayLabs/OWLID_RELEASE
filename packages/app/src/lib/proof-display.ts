import { Token } from '@owlid/sdk/native'
import type { StoredProof } from '@owlid/sdk'

// Re-encode the persisted JSON token as a compact `OID1:` string. The raw
// JSON is far too large for a single QR code (RangeError "Data too long"
// from qrcode.react); the compact form is the canonical wire format.
export function buildQrPayload(p: StoredProof): string {
  try {
    return Token.fromJson(p.tokenJson).toCompact()
  } catch {
    // Last-resort fallback. Likely still too long for a single QR but at
    // least a `Copy` action will surface something to debug with.
    return p.tokenJson
  }
}

export interface ProofGroup {
  label: string
  entries: StoredProof[]
}

// `Today`, `Yesterday`, `Earlier this week`, then absolute month label.
export function groupProofsByDay(proofs: StoredProof[]): ProofGroup[] {
  const buckets = new Map<string, StoredProof[]>()
  const today = startOfDay(new Date())
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const weekAgo = new Date(today)
  weekAgo.setDate(today.getDate() - 6)

  const sorted = [...proofs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )

  for (const p of sorted) {
    const d = startOfDay(new Date(p.createdAt))
    let label: string
    if (sameDay(d, today)) label = 'Today'
    else if (sameDay(d, yesterday)) label = 'Yesterday'
    else if (d > weekAgo) label = 'Earlier this week'
    else label = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

    const bucket = buckets.get(label)
    if (bucket) bucket.push(p)
    else buckets.set(label, [p])
  }

  return Array.from(buckets.entries()).map(([label, entries]) => ({ label, entries }))
}

export function relativeTime(d: Date): string {
  const diffMs = Date.now() - d.getTime()
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 4) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function sameDay(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime()
}
