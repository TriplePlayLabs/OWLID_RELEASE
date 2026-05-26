import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Search, ShieldCheck, Trash2 } from 'lucide-react'
import { BackLink } from '~/components/BackLink'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { proofStorage, type StoredProof } from '@owlid/sdk'
import { Button } from '@owlid/ui/components/ui/button'
import { Input } from '@owlid/ui/components/ui/input'
import { openConfirmModal } from '@owlid/ui/modal'
import { RecentProofRow } from '~/components/identity/RecentProofRow'
import { buildQrPayload, groupProofsByDay } from '~/lib/proof-display'
import { openProofQrModal } from '~/features/identity/proofs/ProofQrModal'

export const Route = createFileRoute('/_identity/recent-proofs')({
  component: RecentProofsPage,
})

const PROOFS_QUERY_KEY = ['identity', 'proofs', 'all'] as const

function RecentProofsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const proofs = useQuery({
    queryKey: PROOFS_QUERY_KEY,
    queryFn: () => proofStorage.getAllProofs(),
    staleTime: 0,
  })

  const deleteOne = useMutation({
    mutationFn: (id: string) => proofStorage.deleteProof(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROOFS_QUERY_KEY }),
  })

  const clearAll = useMutation({
    mutationFn: () => proofStorage.clearAllProofs(),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROOFS_QUERY_KEY }),
  })

  const [query, setQuery] = useState('')

  const items = proofs.data ?? []
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (p) =>
        p.claim.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q),
    )
  }, [items, query])

  const grouped = useMemo(() => groupProofsByDay(filtered), [filtered])

  const handleClearAll = async () => {
    const result = await openConfirmModal({
      title: 'Clear all proofs?',
      description:
        'This deletes every proof stored locally on this device. Your identity and credential are unaffected.',
      confirmLabel: 'Clear all',
      dismissLabel: 'Cancel',
      variant: 'destructive',
    })
    if (result === 'confirmed') clearAll.mutate()
  }

  const handleDelete = async (proof: StoredProof) => {
    const result = await openConfirmModal({
      title: 'Delete this proof?',
      description: `Remove "${proof.claim}" from this device. The credential and identity remain.`,
      confirmLabel: 'Delete',
      dismissLabel: 'Cancel',
      variant: 'destructive',
    })
    if (result === 'confirmed') deleteOne.mutate(proof.id)
  }

  const handleCopy = async (p: StoredProof) => {
    await navigator.clipboard.writeText(buildQrPayload(p))
    toast.success('Proof payload copied')
  }

  const handleShare = async (p: StoredProof) => {
    const text = buildQrPayload(p)
    if (navigator.share) {
      try {
        await navigator.share({ title: `OwlID proof: ${p.claim}`, text })
        return
      } catch {
        /* fall through */
      }
    }
    await navigator.clipboard.writeText(text)
    toast.success('Proof payload copied')
  }

  return (
    <div className="w-full max-w-3xl mx-auto px-4 pt-6 md:pt-10 pb-16">
      <BackLink to="/wallet" />
      <header className="flex items-start justify-between gap-3 mb-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Recent proofs</h1>
          <p className="text-sm text-muted-foreground">
            Cryptographic proofs minted on this device. Tap a row for QR, copy, or share.
          </p>
        </div>
        {items.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-red-400 hover:text-red-300 hover:bg-red-500/10"
            onClick={handleClearAll}
          >
            <Trash2 className="w-4 h-4 mr-2" /> Clear all
          </Button>
        )}
      </header>

      {items.length > 0 && (
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by claim, name, or ID"
            className="pl-9 bg-secondary/40 border-white/10 focus:border-white/20"
          />
        </div>
      )}

      {proofs.isPending && (
        <ul className="space-y-2">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="h-16 rounded-xl bg-white/5 border border-white/5 animate-pulse"
            />
          ))}
        </ul>
      )}

      {proofs.isError && (
        <p className="text-center text-sm text-destructive py-12">
          Failed to load proofs: {(proofs.error as Error).message}
        </p>
      )}

      {!proofs.isPending && items.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/10 px-6 py-16 flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-3">
            <ShieldCheck className="w-5 h-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">No proofs yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs">
            Generate a proof from a credential in your wallet. It will appear here so you can resend
            it without re-authenticating.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={() => navigate({ to: '/wallet' })}
          >
            Go to wallet
          </Button>
        </div>
      )}

      {!proofs.isPending && items.length > 0 && filtered.length === 0 && (
        <p className="text-center text-sm text-muted-foreground py-10">
          No proofs match “{query}”.
        </p>
      )}

      {filtered.length > 0 && (
        <div className="space-y-6">
          {grouped.map(({ label, entries }) => (
            <section key={label} className="space-y-2">
              <h2 className="text-xs uppercase tracking-wider text-muted-foreground">{label}</h2>
              <ul className="rounded-xl border border-white/10 bg-card/30 divide-y divide-white/5 overflow-hidden">
                {entries.map((p) => (
                  <li key={p.id + p.createdAt}>
                    <RecentProofRow
                      proof={p}
                      onShowQr={() => openProofQrModal({ proof: p })}
                      onCopy={() => handleCopy(p)}
                      onShare={() => handleShare(p)}
                      onDelete={() => handleDelete(p)}
                      deletePending={deleteOne.isPending}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
