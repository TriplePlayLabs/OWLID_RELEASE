import { Copy, MoreHorizontal, QrCode, Share2, ShieldCheck, Trash2 } from 'lucide-react'
import type { StoredProof } from '@owlid/sdk'
import { Button } from '@owlid/ui/components/ui/button'
import { Badge } from '@owlid/ui/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@owlid/ui/components/ui/dropdown-menu'
import { relativeTime } from '~/lib/proof-display'

export interface RecentProofRowProps {
  proof: StoredProof
  onShowQr: () => void
  onCopy: () => void
  onShare: () => void
  onDelete: () => void
  deletePending: boolean
}

// Row uses a `div` (not `<button>`) with `role="button"` so the embedded
// `DropdownMenuTrigger` can render its own `<button>` without producing
// invalid nested-interactive HTML.
export function RecentProofRow({
  proof,
  onShowQr,
  onCopy,
  onShare,
  onDelete,
  deletePending,
}: RecentProofRowProps) {
  const time = new Date(proof.createdAt)

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onShowQr()
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onShowQr}
      onKeyDown={onKeyDown}
      className="w-full px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-white/5 focus:outline-none focus-visible:bg-white/5 transition-colors"
    >
      <span
        className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
          proof.result ? 'bg-green-500/15 text-green-400' : 'bg-red-500/10 text-red-400/80'
        }`}
      >
        <ShieldCheck className="w-4 h-4" />
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium truncate">{proof.claim}</p>
          <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
            {proof.id}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          <time dateTime={time.toISOString()}>{relativeTime(time)}</time>
          <span className="mx-1.5">·</span>
          <span>{time.toLocaleString()}</span>
        </p>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
            aria-label="Proof actions"
          >
            <MoreHorizontal className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onClick={(e) => e.stopPropagation()}
          className="bg-zinc-950 border-white/10"
        >
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              onShowQr()
            }}
          >
            <QrCode className="w-4 h-4 mr-2" /> Show QR
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              onCopy()
            }}
          >
            <Copy className="w-4 h-4 mr-2" /> Copy payload
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              onShare()
            }}
          >
            <Share2 className="w-4 h-4 mr-2" /> Share
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-white/10" />
          <DropdownMenuItem
            disabled={deletePending}
            className="cursor-pointer text-red-400 focus:text-red-400 focus:bg-red-500/10"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            <Trash2 className="w-4 h-4 mr-2" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
