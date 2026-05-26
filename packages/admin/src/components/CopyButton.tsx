import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@owlid/ui/components/ui/button'
import { cn } from '@owlid/ui/lib/utils'

interface CopyButtonProps {
  value: string
  /** What was copied — used in the toast ("X copied"). */
  label?: string
  className?: string
}

/** Icon button that copies `value` to the clipboard and flips to a check
 *  for 1.5s. Falls back to an error toast when the clipboard is denied. */
export function CopyButton({ value, label = 'Value', className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success(`${label} copied`)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Clipboard unavailable — copy manually')
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('h-7 w-7 shrink-0', className)}
      onClick={copy}
      aria-label={`Copy ${label.toLowerCase()}`}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  )
}
