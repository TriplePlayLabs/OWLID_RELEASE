import type { StoredProof } from '@owlid/sdk'

// The stored SD-JWT VC presentation is already the compact wire format
// (`<JWT>~<disclosure>~…~<KB-JWT>`) — encode it directly into the QR.
export function buildQrPayload(p: StoredProof): string {
  return p.presentation
}

export interface ProofGroup {
  label: string
  entries: StoredProof[]
}

// Free-text filter over a proof's claim, display name, and predicate id.
// Empty/whitespace query returns the list unchanged.
export function filterProofs(proofs: StoredProof[], query: string): StoredProof[] {
  const q = query.trim().toLowerCase()
  if (!q) return proofs
  return proofs.filter(
    (p) =>
      p.claim.toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q) ||
      p.predicateId.toLowerCase().includes(q),
  )
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
