import type { Bank } from '~/types/identity'
import { BANKS } from '~/constants/banks'

interface BankSelectorProps {
  onSelect: (bank: Bank) => void
}

export function BankSelector({ onSelect }: BankSelectorProps) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground mb-4">
        Choose your bank to verify your identity:
      </p>
      <div className="grid grid-cols-3 gap-2">
        {BANKS.map((bank) => (
          <button
            key={bank.id}
            onClick={() => onSelect(bank)}
            aria-label={`Select ${bank.name}`}
            className="flex flex-col items-center gap-2 p-3 rounded-lg border border-white/10 hover:border-white/30 hover:bg-white/5 transition-all group"
            data-testid={`bank-select-${bank.id}`}
          >
            <div
              className={`w-10 h-10 rounded-full ${bank.color} flex items-center justify-center text-white font-bold text-sm`}
            >
              {bank.name.charAt(0)}
            </div>
            <span className="text-xs text-muted-foreground group-hover:text-white transition-colors text-center leading-tight">
              {bank.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
