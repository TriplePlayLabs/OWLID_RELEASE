import { Copy, ShieldCheck, ShieldX } from 'lucide-react'
import { toast } from 'sonner'
import type { StoredProof } from '@owlid/sdk'
import { Button } from '@owlid/ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@owlid/ui/components/ui/dialog'
import { registerModal, type ModalRenderProps } from '@owlid/ui/modal'
import { buildQrPayload, relativeTime } from '~/lib/proof-display'

interface Args {
  proof: StoredProof
}

/**
 * Read-only view of a past proof. A stored proof is a receipt: its KB-JWT
 * was bound to a one-shot verifier challenge that is already consumed, so
 * it can't be re-presented — there's nothing to scan. We show what was
 * proven, to whom, and when, and keep Copy for manual inspection.
 */
export function ProofDetailsModal({ isOpen, args, close }: ModalRenderProps<Args>) {
  const { proof } = args

  const handleCopy = async () => {
    await navigator.clipboard.writeText(buildQrPayload(proof))
    toast.success('Proof payload copied')
  }

  const created = new Date(proof.createdAt)
  const expiry = proof.expiresAt ? new Date(proof.expiresAt) : null
  const expired = expiry ? expiry.getTime() < Date.now() : false

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className={`p-1.5 rounded-full ring-1 ${
                proof.result
                  ? 'bg-green-500/15 text-green-400 ring-green-500/20'
                  : 'bg-red-500/10 text-red-400 ring-red-500/20'
              }`}
            >
              {proof.result ? <ShieldCheck className="w-4 h-4" /> : <ShieldX className="w-4 h-4" />}
            </span>
            {proof.claim}
          </DialogTitle>
          <DialogDescription>
            A receipt of a proof you presented. It was bound to a one-shot challenge that has since
            expired, so it can&apos;t be reused.
          </DialogDescription>
        </DialogHeader>

        <dl className="space-y-2.5 text-sm">
          <Row label="Result">
            <span className={proof.result ? 'text-green-400' : 'text-red-400'}>
              {proof.result ? 'Satisfied' : 'Not satisfied'}
            </span>
          </Row>
          <Row label="Predicate">
            <span className="font-mono text-xs">{proof.predicateId}</span>
          </Row>
          {proof.name && <Row label="Shown to">{proof.name}</Row>}
          <Row label="Created">
            <span title={created.toLocaleString()}>
              {created.toLocaleString()} · {relativeTime(created)}
            </span>
          </Row>
          {expiry && (
            <Row label={expired ? 'Expired' : 'Expires'}>
              <span className={expired ? 'text-muted-foreground' : undefined}>
                {expiry.toLocaleString()} · {relativeTime(expiry)}
              </span>
            </Row>
          )}
        </dl>

        <DialogFooter>
          <Button variant="secondary" className="w-full" onClick={handleCopy}>
            <Copy className="w-4 h-4 mr-2" />
            Copy proof payload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground shrink-0">{label}</dt>
      <dd className="text-right text-foreground">{children}</dd>
    </div>
  )
}

export const { open: openProofDetailsModal } = registerModal<Args>(ProofDetailsModal, {
  key: 'identity:proof-details',
  defaultArgs: { proof: undefined as unknown as StoredProof },
})
