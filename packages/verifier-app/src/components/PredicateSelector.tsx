import { useEffect, useState } from 'react'
import { CheckSquare, Square, Shield, X, User, Loader2 } from 'lucide-react'
import type { PresentationPredicate } from '@owlid/sdk'
import { Button } from '@owlid/ui/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@owlid/ui/components/ui/card'
import { Input } from '@owlid/ui/components/ui/input'
import { Label } from '@owlid/ui/components/ui/label'
import { listPredicates, type PredicateInfo } from '../api'

interface PredicateSelectorProps {
  onSubmit: (predicates: PresentationPredicate[], verifierName: string) => void
  onCancel: () => void
}

export function PredicateSelector({ onSubmit, onCancel }: PredicateSelectorProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [verifierName, setVerifierName] = useState('Verifier')
  const [registry, setRegistry] = useState<PredicateInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listPredicates()
      .then((preds) => {
        if (!cancelled) setRegistry(preds)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSubmit = () => {
    if (!registry) return
    const predicates: PresentationPredicate[] = registry
      .filter((p) => selected.has(p.id))
      .map((p) => ({ id: p.id, label: p.label }))
    onSubmit(predicates, verifierName.trim() || 'Verifier')
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-blue-400" />
          Select Verification Checks
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={onCancel} aria-label="Cancel">
          <X className="w-4 h-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Choose which attributes to verify. The holder will see these on their consent screen.
        </p>

        <div className="space-y-2">
          <Label htmlFor="verifier-name" className="flex items-center gap-1.5">
            <User className="w-3.5 h-3.5" />
            Your display name
          </Label>
          <Input
            id="verifier-name"
            type="text"
            value={verifierName}
            onChange={(e) => setVerifierName(e.target.value)}
            placeholder="Verifier"
          />
          <p className="text-xs text-muted-foreground">
            Shown on the holder's consent screen so they know who is requesting
          </p>
        </div>

        {error && <p className="text-sm text-destructive">Failed to load predicates: {error}</p>}

        {!registry && !error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading predicates…
          </div>
        )}

        {registry && (
          <div className="overflow-hidden rounded-md border">
            {registry.map((predicate, idx) => {
              const isChecked = selected.has(predicate.id)
              return (
                <button
                  type="button"
                  key={predicate.id}
                  onClick={() => toggle(predicate.id)}
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 ${
                    idx > 0 ? 'border-t' : ''
                  }`}
                >
                  {isChecked ? (
                    <CheckSquare className="h-5 w-5 shrink-0 text-blue-400" />
                  ) : (
                    <Square className="h-5 w-5 shrink-0 text-muted-foreground" />
                  )}
                  <span className={`text-sm ${isChecked ? '' : 'text-muted-foreground'}`}>
                    {predicate.label}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground">
          {selected.size} check{selected.size !== 1 ? 's' : ''} selected
        </p>
      </CardContent>
      <CardFooter>
        <Button
          onClick={handleSubmit}
          disabled={selected.size === 0 || !registry}
          className="w-full"
        >
          <Shield className="w-4 h-4" />
          Send Verification Request
        </Button>
      </CardFooter>
    </Card>
  )
}
