import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@owlid/ui/components/ui/button'
import { Checkbox } from '@owlid/ui/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@owlid/ui/components/ui/dialog'
import { revokeAllCredentials } from '~/hooks/use-revoke'

interface ResetIdentityDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Local device wipe (clearAll + reload). Runs after any on-chain revoke. */
  onWipe: () => void
}

/**
 * Reset & clear identity (GH #16). Reset is a device-local wipe by default.
 * The opt-in checkbox additionally reports the credential lost — a holder
 * proof-of-possession self-revocation that flips it to revoked on-chain so
 * verifiers reject it everywhere. Revocation runs BEFORE the wipe (it needs
 * the holder key that the wipe destroys); a revoke failure aborts the wipe so
 * the holder doesn't lose a credential that wasn't actually revoked.
 */
export function ResetIdentityDialog({ open, onOpenChange, onWipe }: ResetIdentityDialogProps) {
  const [revokeOnChain, setRevokeOnChain] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleConfirm = async () => {
    setBusy(true)
    try {
      if (revokeOnChain) {
        await revokeAllCredentials('holder reset — reported lost')
        toast.success('Your ID was revoked on the network.')
      }
      onWipe()
    } catch (error) {
      toast.error('Could not revoke on the network', {
        description:
          error instanceof Error
            ? `${error.message} — your ID was NOT wiped, so you can try again.`
            : 'Your ID was NOT wiped, so you can try again.',
      })
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Reset &amp; clear identity</DialogTitle>
          <DialogDescription>
            This wipes your wallet from THIS device only. Your IDs are stored only here, so they
            will be gone for good.
          </DialogDescription>
        </DialogHeader>

        <label
          htmlFor="reset-revoke"
          className="flex items-start gap-2 rounded-md border border-white/10 bg-zinc-950/40 p-3 text-sm"
        >
          <Checkbox
            id="reset-revoke"
            checked={revokeOnChain}
            onCheckedChange={(v) => setRevokeOnChain(v === true)}
            disabled={busy}
            className="mt-0.5"
          />
          <span>
            Also revoke my ID on the network (report it lost). This is permanent — verifiers will
            reject it everywhere. Requires your passkey.
          </span>
        </label>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={busy}>
            {busy ? 'Working…' : revokeOnChain ? 'Revoke & wipe' : 'Wipe this device'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
