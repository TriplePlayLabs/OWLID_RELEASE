import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

interface BackLinkProps {
  to: '/wallet' | '/add-provider' | '/'
  label?: string
  className?: string
}

/**
 * Shared sub-page back link. Single style across the app so the user
 * always recognises "go up one level" the same way. Defaults the
 * label from the destination so each call site only needs to point
 * somewhere sensible.
 */
export function BackLink({ to, label, className }: BackLinkProps) {
  const text = label ?? DEFAULT_LABEL[to]
  return (
    <Link
      to={to}
      className={`mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors ${
        className ?? ''
      }`}
    >
      <ArrowLeft className="w-3.5 h-3.5" /> {text}
    </Link>
  )
}

const DEFAULT_LABEL: Record<BackLinkProps['to'], string> = {
  '/wallet': 'Wallet',
  '/add-provider': 'Add provider',
  '/': 'Home',
}
