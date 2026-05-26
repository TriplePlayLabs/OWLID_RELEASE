import { Tooltip, TooltipContent, TooltipTrigger } from '@owlid/ui/components/ui/tooltip'

function relative(value: string | Date): string {
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return String(value)
  const diff = Date.now() - then
  const abs = Math.abs(diff)
  const suffix = diff >= 0 ? 'ago' : 'from now'
  const units: [number, string][] = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1_000, 's'],
  ]
  for (const [ms, label] of units) {
    if (abs >= ms) return `${Math.floor(abs / ms)}${label} ${suffix}`
  }
  return 'just now'
}

/** Compact relative timestamp ("3h ago") with the full local time on hover. */
export function RelativeTime({ value }: { value?: string | Date | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-muted-foreground cursor-default">{relative(value)}</span>
      </TooltipTrigger>
      <TooltipContent>{new Date(value).toLocaleString()}</TooltipContent>
    </Tooltip>
  )
}
