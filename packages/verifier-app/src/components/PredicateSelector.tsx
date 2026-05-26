import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronsUpDown,
  Fingerprint,
  ListChecks,
  Loader2,
  Send,
  User,
  X,
} from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import { Input } from '@owlid/ui/components/ui/input'
import { Label } from '@owlid/ui/components/ui/label'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@owlid/ui/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@owlid/ui/components/ui/popover'
import { cn } from '@owlid/ui/lib/utils'
import { ALL_COUNTRIES, COUNTRY_PRESETS, countryName } from '@owlid/sdk'
import { listPredicates, type PredicateInfo } from '../api'
import type { PredicateParamInput } from '../App'

/** A unique-personhood campaign request: one human, one claim per round. */
export interface CampaignRequest {
  campaignId: string
  round: string
}

interface PredicateSelectorProps {
  onSubmit: (
    predicates: PredicateInfo[],
    verifierName: string,
    campaign?: CampaignRequest,
    params?: Map<string, PredicateParamInput>,
  ) => void
  onCancel: () => void
}

const DEFAULT_AGE_THRESHOLD = 18
const DEFAULT_AGE_MIN = 18
const DEFAULT_AGE_MAX = 99
const AGE_THRESHOLD_PRESETS = [18, 21, 65]
const AGE_RANGE_PRESETS: ReadonlyArray<readonly [number, number]> = [
  [18, 25],
  [26, 64],
  [65, 99],
]
/** Hard cap on the verifier's allowed-set, matching the Compact
 *  `Vector<64, Bytes<32>>` witness. Mirrors `MAX_COUNTRIES_PER_SET`
 *  in `packages/sdk/src/midnight/routing.ts`. */
const MAX_COUNTRIES_PER_SET = 64

export function PredicateSelector({ onSubmit, onCancel }: PredicateSelectorProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [verifierName, setVerifierName] = useState('Verifier')
  const [registry, setRegistry] = useState<PredicateInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [ageThreshold, setAgeThreshold] = useState(DEFAULT_AGE_THRESHOLD)
  const [ageMin, setAgeMin] = useState(DEFAULT_AGE_MIN)
  const [ageMax, setAgeMax] = useState(DEFAULT_AGE_MAX)
  const [campaignId, setCampaignId] = useState('')
  const [round, setRound] = useState('1')
  const [nationalityCountries, setNationalityCountries] = useState<string[]>([])
  const [residencyCountries, setResidencyCountries] = useState<string[]>([])

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

  const personhoodSelected = selected.has('personhood:unique')
  const campaignReady = personhoodSelected && campaignId.trim().length > 0
  const nationalitySelected = selected.has('nationality:in')
  const residencySelected = selected.has('residency:in')
  const canSubmit =
    !!registry &&
    selected.size > 0 &&
    (!personhoodSelected || campaignReady) &&
    (!nationalitySelected || nationalityCountries.length > 0) &&
    (!residencySelected || residencyCountries.length > 0)

  const handleSubmit = () => {
    if (!registry || !canSubmit) return
    const predicates = registry.filter((p) => selected.has(p.id))
    const campaign: CampaignRequest | undefined = campaignReady
      ? { campaignId: campaignId.trim(), round: round.trim() || '1' }
      : undefined
    const params = new Map<string, PredicateParamInput>()
    if (selected.has('age:gte')) params.set('age:gte', { threshold: ageThreshold })
    if (selected.has('age:range')) params.set('age:range', { min: ageMin, max: ageMax })
    if (nationalitySelected && nationalityCountries.length > 0) {
      params.set('nationality:in', { countries: nationalityCountries })
    }
    if (residencySelected && residencyCountries.length > 0) {
      params.set('residency:in', { countries: residencyCountries })
    }
    onSubmit(predicates, verifierName.trim() || 'Verifier', campaign, params)
  }

  return (
    // Single flat container — no nested Card. Sticky footer on mobile so the
    // primary action stays reachable even with a long predicate list.
    <div className="flex flex-col gap-4 pb-24 sm:pb-0">
      {/* Header row — title + close on a single line, no Card chrome. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <ListChecks className="w-5 h-5 text-muted-foreground shrink-0" />
          <h2 className="text-base font-semibold truncate">What do you need to check?</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onCancel}
          aria-label="Cancel"
          className="shrink-0 h-8 w-8"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Verifier name — flat input, no extra container. */}
      <div className="space-y-1.5">
        <Label htmlFor="verifier-name" className="flex items-center gap-1.5 text-xs">
          <User className="w-3 h-3" />
          Your name
        </Label>
        <Input
          id="verifier-name"
          type="text"
          value={verifierName}
          onChange={(e) => setVerifierName(e.target.value)}
          placeholder="Verifier"
          className="h-10"
        />
        <p className="text-[11px] text-muted-foreground leading-snug">
          The holder sees this on their approval screen.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">Couldn’t load the checks: {error}</p>}

      {!registry && !error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading checks…
        </div>
      )}

      {registry && (
        <div className="space-y-1.5">
          <Label className="text-xs">Checks to request</Label>
          {/* Single bordered list — items separated by inner dividers, no
              per-row Card wrapping. */}
          <ul className="divide-y divide-white/5 rounded-lg border border-white/10 bg-zinc-950/40">
            {registry.map((predicate) => {
              const isChecked = selected.has(predicate.id)
              const isPersonhood = predicate.id === 'personhood:unique'
              return (
                <li key={predicate.id}>
                  <button
                    type="button"
                    onClick={() => toggle(predicate.id)}
                    className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-white/5 active:bg-white/10 min-h-[44px]"
                  >
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                        isChecked
                          ? 'border-foreground bg-foreground text-background'
                          : 'border-white/20',
                      )}
                    >
                      {isChecked && <Check className="h-3.5 w-3.5" />}
                    </span>
                    {isPersonhood && (
                      <Fingerprint className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span
                      className={cn(
                        'text-sm flex-1',
                        isChecked ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {predicate.label}
                    </span>
                  </button>

                  {/* Inline sub-input — flush left, no inner card. */}
                  {isChecked && predicate.id === 'age:gte' && (
                    <div className="space-y-2 px-3 pb-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Label htmlFor="age-threshold" className="text-xs">
                          Minimum age
                        </Label>
                        <Input
                          id="age-threshold"
                          type="number"
                          min={0}
                          max={120}
                          value={ageThreshold}
                          onChange={(e) => setAgeThreshold(Number(e.target.value))}
                          className="h-8 w-20"
                        />
                        <div className="flex gap-1 ml-auto">
                          {AGE_THRESHOLD_PRESETS.map((n) => (
                            <Chip
                              key={n}
                              active={ageThreshold === n}
                              onClick={() => setAgeThreshold(n)}
                            >
                              {n}+
                            </Chip>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {isChecked && predicate.id === 'age:range' && (
                    <div className="space-y-2 px-3 pb-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Label htmlFor="age-min" className="text-xs">
                          From
                        </Label>
                        <Input
                          id="age-min"
                          type="number"
                          min={0}
                          max={120}
                          value={ageMin}
                          onChange={(e) => setAgeMin(Number(e.target.value))}
                          className="h-8 w-16"
                        />
                        <Label htmlFor="age-max" className="text-xs">
                          to
                        </Label>
                        <Input
                          id="age-max"
                          type="number"
                          min={0}
                          max={120}
                          value={ageMax}
                          onChange={(e) => setAgeMax(Number(e.target.value))}
                          className="h-8 w-16"
                        />
                      </div>
                      <div className="flex gap-1 flex-wrap">
                        {AGE_RANGE_PRESETS.map(([lo, hi]) => (
                          <Chip
                            key={`${lo}-${hi}`}
                            active={ageMin === lo && ageMax === hi}
                            onClick={() => {
                              setAgeMin(lo)
                              setAgeMax(hi)
                            }}
                          >
                            {lo}–{hi}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  )}

                  {isChecked && predicate.id === 'nationality:in' && (
                    <CountryPicker
                      label="Allowed nationalities"
                      value={nationalityCountries}
                      onChange={setNationalityCountries}
                    />
                  )}

                  {isChecked && predicate.id === 'residency:in' && (
                    <CountryPicker
                      label="Allowed countries of residence"
                      value={residencyCountries}
                      onChange={setResidencyCountries}
                    />
                  )}

                  {isChecked && isPersonhood && (
                    <div className="space-y-2 px-3 pb-3">
                      <p className="text-[11px] text-muted-foreground leading-snug">
                        Proves one human can claim only once — no identity revealed. Campaign +
                        round scope the uniqueness nullifier.
                      </p>
                      <Input
                        id="campaign-id"
                        type="text"
                        value={campaignId}
                        onChange={(e) => setCampaignId(e.target.value)}
                        placeholder="Campaign name (e.g. Spring Airdrop)"
                        className="h-9"
                      />
                      <Input
                        id="campaign-round"
                        type="text"
                        value={round}
                        onChange={(e) => setRound(e.target.value)}
                        placeholder="Round (default: 1)"
                        className="h-9"
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {personhoodSelected && !campaignReady && (
            <p className="text-xs text-destructive">
              Enter a campaign name to request the personhood check.
            </p>
          )}
        </div>
      )}

      {/* Sticky send button — fixed on mobile so it doesn't get lost
          behind a long predicate list, inline on desktop. */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-white/10 bg-background/95 p-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:static sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
        <Button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full h-11 text-sm font-medium"
        >
          <Send className="w-4 h-4 mr-2" />
          Send request to holder
        </Button>
      </div>
    </div>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors min-h-[28px]',
        active
          ? 'bg-foreground text-background'
          : 'bg-white/5 text-muted-foreground hover:bg-white/10',
      )}
    >
      {children}
    </button>
  )
}

/** Mobile-first country combobox. Selected codes render as compact
 *  removable chips above the trigger; the dropdown is full-width on
 *  narrow screens and hard-caps at MAX_COUNTRIES_PER_SET (matches the
 *  on-chain Vector slot). */
function CountryPicker({
  label,
  value,
  onChange,
}: {
  label: string
  value: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const selectedSet = useMemo(() => new Set(value.map((c) => c.toUpperCase())), [value])
  const remaining = MAX_COUNTRIES_PER_SET - value.length

  const toggle = (code: string) => {
    const upper = code.toUpperCase()
    if (selectedSet.has(upper)) {
      onChange(value.filter((c) => c.toUpperCase() !== upper))
    } else if (value.length < MAX_COUNTRIES_PER_SET) {
      onChange([...value, upper])
    }
  }

  const applyPreset = (codes: readonly string[]) => {
    const capped = codes.slice(0, MAX_COUNTRIES_PER_SET).map((c) => c.toUpperCase())
    onChange(capped)
  }

  const clear = () => onChange([])

  return (
    <div className="space-y-2 px-3 pb-3">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">{label}</Label>
        {value.length > 0 && (
          <button
            type="button"
            onClick={clear}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => toggle(code)}
              className="inline-flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[11px] hover:bg-white/10 min-h-[24px]"
              aria-label={`Remove ${countryName(code)}`}
            >
              {code}
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-9 w-full justify-between text-xs font-normal"
          >
            <span className="truncate text-muted-foreground">
              {value.length === 0
                ? 'Search countries…'
                : `${value.length} of ${MAX_COUNTRIES_PER_SET} — add more`}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] max-h-[60vh] p-0"
          align="start"
        >
          <Command
            filter={(itemValue, search) =>
              itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
            }
          >
            <CommandInput placeholder="Search country or code…" className="h-10" />
            <CommandList className="max-h-[50vh]">
              <CommandEmpty>No country matches.</CommandEmpty>
              <CommandGroup heading="Quick presets">
                {COUNTRY_PRESETS.map((preset) => (
                  <CommandItem
                    key={preset.label}
                    value={`preset ${preset.label}`}
                    onSelect={() => {
                      applyPreset(preset.codes)
                      setOpen(false)
                    }}
                    className="text-xs py-2"
                  >
                    <span className="font-medium">{preset.label}</span>
                    <span className="text-muted-foreground ml-auto">
                      {preset.codes.length} countries
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading={`Countries (${remaining} more allowed)`}>
                {ALL_COUNTRIES.map((c) => {
                  const checked = selectedSet.has(c.alpha2)
                  const disabled = !checked && remaining <= 0
                  return (
                    <CommandItem
                      key={c.alpha2}
                      value={`${c.alpha2} ${c.name}`}
                      onSelect={() => {
                        if (!disabled) toggle(c.alpha2)
                      }}
                      className={cn('text-xs py-2', disabled && 'cursor-not-allowed opacity-40')}
                    >
                      <Check
                        className={cn('mr-2 h-3.5 w-3.5', checked ? 'opacity-100' : 'opacity-0')}
                      />
                      <span className="font-mono text-muted-foreground w-7">{c.alpha2}</span>
                      <span className="truncate">{c.name}</span>
                      {c.eu && (
                        <span className="ml-auto rounded bg-blue-500/15 px-1.5 text-[10px] text-blue-300 shrink-0">
                          EU
                        </span>
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {value.length === 0 && <p className="text-[11px] text-destructive">Pick at least one.</p>}
    </div>
  )
}
