import { useState } from 'react'
import { CheckSquare, Square, Shield, X, User } from 'lucide-react'
import { PRESENTATION_PREDICATES, type PresentationPredicate } from '@owlid/sdk'

interface PredicateSelectorProps {
  onSubmit: (predicates: PresentationPredicate[], verifierName: string) => void
  onCancel: () => void
}

export function PredicateSelector({ onSubmit, onCancel }: PredicateSelectorProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [verifierName, setVerifierName] = useState('Verifier')

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const handleSubmit = () => {
    const predicates = PRESENTATION_PREDICATES.filter((p) => selected.has(p.id))
    onSubmit(predicates, verifierName.trim() || 'Verifier')
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold flex items-center gap-2">
          <Shield className="w-5 h-5 text-blue-400" />
          Select Verification Checks
        </h3>
        <button
          onClick={onCancel}
          className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
          aria-label="Cancel"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <p className="text-sm text-zinc-400">
        Choose which attributes to verify. The holder will see these on their consent screen.
      </p>

      {/* Verifier name input */}
      <div className="space-y-1.5">
        <label htmlFor="verifier-name" className="text-sm text-zinc-400 flex items-center gap-1.5">
          <User className="w-3.5 h-3.5" />
          Your display name
        </label>
        <input
          id="verifier-name"
          type="text"
          value={verifierName}
          onChange={(e) => setVerifierName(e.target.value)}
          placeholder="Verifier"
          className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-white/10 text-sm focus:outline-none focus:border-blue-500/50 transition-colors placeholder:text-zinc-600"
        />
        <p className="text-xs text-zinc-600">
          Shown on the holder's consent screen so they know who is requesting
        </p>
      </div>

      {/* Predicate checkboxes */}
      <div className="rounded-xl border border-white/10 bg-zinc-900 overflow-hidden divide-y divide-white/5">
        {PRESENTATION_PREDICATES.map((predicate) => {
          const isChecked = selected.has(predicate.id)
          return (
            <button
              key={predicate.id}
              onClick={() => toggle(predicate.id)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-800 transition-colors text-left"
            >
              {isChecked ? (
                <CheckSquare className="w-5 h-5 text-blue-400 shrink-0" />
              ) : (
                <Square className="w-5 h-5 text-zinc-600 shrink-0" />
              )}
              <span className={`text-sm ${isChecked ? 'text-zinc-200' : 'text-zinc-400'}`}>
                {predicate.label}
              </span>
            </button>
          )
        })}
      </div>

      <p className="text-xs text-zinc-500 text-center">
        {selected.size} check{selected.size !== 1 ? 's' : ''} selected
      </p>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={selected.size === 0}
        className="w-full flex items-center justify-center gap-2 p-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Shield className="w-4 h-4" />
        Send Verification Request
      </button>
    </div>
  )
}
