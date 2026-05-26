import type { ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Skeleton } from '@owlid/ui/components/ui/skeleton'
import { Button } from '@owlid/ui/components/ui/button'
import { TableCell, TableRow } from '@owlid/ui/components/ui/table'

/** Placeholder rows shown while a table query is loading. */
export function TableSkeleton({ rows = 4, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <TableRow key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <TableCell key={c}>
              <Skeleton className="h-4 w-full max-w-[160px]" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

/** Single full-width row for the error state, with a retry button. */
export function TableError({
  colSpan,
  message,
  onRetry,
}: {
  colSpan: number
  message: string
  onRetry?: () => void
}) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan}>
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <AlertTriangle className="h-6 w-6 text-destructive" />
          <p className="text-sm text-destructive">{message}</p>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" /> Retry
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

/** Single full-width row for the empty state, with an optional CTA. */
export function TableEmpty({
  colSpan,
  icon,
  title,
  description,
  action,
}: {
  colSpan: number
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan}>
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          {icon && <div className="text-muted-foreground">{icon}</div>}
          <p className="text-sm font-medium">{title}</p>
          {description && <p className="text-xs text-muted-foreground max-w-sm">{description}</p>}
          {action && <div className="mt-2">{action}</div>}
        </div>
      </TableCell>
    </TableRow>
  )
}
