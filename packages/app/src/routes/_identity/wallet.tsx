import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fingerprint, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { storage, type WalletCredential } from '@owlid/sdk'
import { Button } from '@owlid/ui/components/ui/button'
import { Card, CardContent } from '@owlid/ui/components/ui/card'
import { CardRenderer } from '~/components/cards/CardRenderer'
import { CardBackFace } from '~/components/cards/CardBackFace'
import { openPresentationModal } from '~/features/identity/presentation/PresentationModal'
import { readAuthState, ROUTE_FOR_STATE } from '~/lib/auth-gate'

export const Route = createFileRoute('/_identity/wallet')({
  beforeLoad: async () => {
    const state = await readAuthState()
    if (state.kind === 'unknown' || state.kind === 'has-wallet') return
    throw redirect({ to: ROUTE_FOR_STATE[state.kind], replace: true })
  },
  component: WalletPage,
})

function WalletPage() {
  const navigate = useNavigate()
  // Track which card is "open" (flipped + details panel expanded). Only
  // one card open at a time. Tap a card to toggle.
  const [openId, setOpenId] = useState<string | null>(null)
  // Client-mount guard so SSR + first hydration render the same markup
  // (localStorage is empty on the server).
  const [isMounted, setIsMounted] = useState(false)
  useEffect(() => {
    setIsMounted(true)
  }, [])

  const credentials = useQuery({
    queryKey: ['wallet', 'credentials'],
    queryFn: () => storage.listCredentials(),
    enabled: isMounted,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  })

  if (!isMounted || credentials.isPending) return null
  const list = credentials.data ?? []

  return (
    <div className="w-full max-w-md mx-auto px-4 pt-6 pb-12">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Wallet</h1>
          <p className="text-xs text-muted-foreground">
            {list.length} {list.length === 1 ? 'card' : 'cards'}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => navigate({ to: '/add-provider' })}
          className="h-9"
          data-testid="button-add-provider"
        >
          <Plus className="w-4 h-4 mr-1" />
          Add
        </Button>
      </div>

      {/* Apple-Wallet-style stack. Every card stays mounted (so opening
          one animates rather than remounting); while a card is open the
          CSS hides the rest of the stack — only the flipped card and
          its details show. */}
      <div className="card-stack pt-6">
        {list.map((cred, i) => {
          const isOpen = openId === cred.credentialId
          return (
            <div
              key={cred.credentialId}
              className={`card-stack__item ${isOpen ? 'card-stack__item--open' : ''}`}
              style={{
                ['--stack-index' as string]: i,
                ['--stack-count' as string]: list.length,
              }}
            >
              <WalletCardSlot
                credential={cred}
                isOpen={isOpen}
                onToggle={() =>
                  setOpenId((prev) => (prev === cred.credentialId ? null : cred.credentialId))
                }
                onRemoved={() => setOpenId(null)}
              />
            </div>
          )
        })}
      </div>

      {/* Disabled when wallet is empty — nothing to disclose. Title
          spells out why on hover. */}
      <div className="mt-10">
        <Button
          onClick={() => openPresentationModal({})}
          disabled={list.length === 0}
          className="w-full h-11 text-sm font-medium bg-white text-black hover:bg-white/90 disabled:opacity-40 disabled:cursor-not-allowed"
          title={list.length === 0 ? 'Add a card first' : 'Show a code for someone to scan'}
          data-testid="button-present-id"
        >
          <Fingerprint className="w-4 h-4 mr-1.5" />
          Present
        </Button>
      </div>

      <div className="mt-8 text-center">
        <button
          type="button"
          onClick={() => navigate({ to: '/recent-proofs' })}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Recent proofs →
        </button>
      </div>
    </div>
  )
}

/**
 * A single slot in the wallet stack. Closed state shows just the brand
 * chrome (front face); open state flips to the back face and reveals
 * the per-credential details panel (full claim grid + provenance +
 * remove action) below.
 */
function WalletCardSlot({
  credential,
  isOpen,
  onToggle,
  onRemoved,
}: {
  credential: WalletCredential
  isOpen: boolean
  onToggle: () => void
  onRemoved: () => void
}) {
  const qc = useQueryClient()
  const removeMut = useMutation({
    mutationFn: () => storage.removeCredential(credential.credentialId),
    onSuccess: () => {
      onRemoved()
      // Drop it from the cache immediately so the card vanishes without
      // waiting for a refetch; invalidate as a consistency backstop.
      qc.setQueryData<WalletCredential[]>(['wallet', 'credentials'], (old) =>
        (old ?? []).filter((c) => c.credentialId !== credential.credentialId),
      )
      qc.invalidateQueries({ queryKey: ['wallet'] })
      toast.success('Card removed', { description: 'Deleted from this device.' })
    },
  })

  const isPassport = credential.cardShape.kind === 'passport'

  return (
    <div>
      {/* Closed: a uniform credit-card. On tap the card flips (the
          `.card-book` rotateY transition). A passport additionally
          grows to a real ICAO passport-page aspect as it flips, so its
          back face is the full-dimension data page. */}
      {isPassport ? (
        <PassportFlip
          isOpen={isOpen}
          onToggle={onToggle}
          front={<CardRenderer credential={credential} />}
          back={<CardBackFace credential={credential} />}
        />
      ) : (
        <FlipCard
          isOpen={isOpen}
          onToggle={onToggle}
          front={<CardRenderer credential={credential} />}
          back={<CardBackFace credential={credential} />}
        />
      )}

      {isOpen && (
        <div className="mt-3 space-y-3">
          <CredentialDetails credential={credential} />
          <button
            type="button"
            className="w-full flex items-center justify-center gap-1.5 h-9 rounded-md text-xs text-destructive/80 hover:text-destructive hover:bg-destructive/5 transition-colors"
            onClick={() => {
              if (
                confirm('Remove this card from your wallet? It will be deleted from this device.')
              ) {
                removeMut.mutate()
              }
            }}
            disabled={removeMut.isPending}
            data-testid="button-remove-credential"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Remove card
          </button>
        </div>
      )}
    </div>
  )
}

/** Lightweight in-place 3D flip. Same physics as `.card-book` but the
 *  height tracks the credit-card front (h-56) so the open card sits in
 *  the same slot the user just tapped — no jump. */
function FlipCard({
  isOpen,
  onToggle,
  front,
  back,
}: {
  isOpen: boolean
  onToggle: () => void
  front: React.ReactNode
  back: React.ReactNode
}) {
  return (
    <div className="card-book-container">
      <div
        className={`card-book ${isOpen ? 'is-open' : ''}`}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        aria-pressed={isOpen}
        aria-label={isOpen ? 'Close card' : 'Open card'}
      >
        <div className="card-book__face">{front}</div>
        <div className="card-book__face card-book__back">{back}</div>
      </div>
    </div>
  )
}

/**
 * Passport flip. Closed it is a credit-card (14rem tall); on open the
 * container grows to a real ICAO passport-page aspect (88 × 125 mm)
 * while the inner `.card-book` flips — so the data page on the back is
 * shown at true passport dimensions. The open height is the card width
 * × 125/88, measured live so it tracks responsive widths.
 */
function PassportFlip({
  isOpen,
  onToggle,
  front,
  back,
}: {
  isOpen: boolean
  onToggle: () => void
  front: React.ReactNode
  back: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [openHeight, setOpenHeight] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setOpenHeight((el.offsetWidth * 125) / 88)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      className="passport-flip-container"
      style={{ height: isOpen && openHeight ? `${openHeight}px` : '14rem' }}
    >
      <div
        className={`card-book ${isOpen ? 'is-open' : ''}`}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        aria-pressed={isOpen}
        aria-label={isOpen ? 'Close card' : 'Open card'}
      >
        <div className="card-book__face">{front}</div>
        <div className="card-book__face card-book__back">{back}</div>
      </div>
    </div>
  )
}

// Per-card-kind allow-list. Drops synthetic noise (DOB=1900-01-01 +
// is_over_X=false + EU=false + national_id=<google_sub> etc.) the
// normalizer emits when the source provider can't actually vouch for
// the field. Order is the display order.
const CLAIM_ORDER: Record<string, readonly string[]> = {
  passport: [
    'firstName',
    'lastName',
    'dateOfBirth',
    'placeOfBirth',
    'nationality',
    'gender',
    'nationalId',
    'passportNumber',
    'driversLicense',
    'documentType',
    'documentNumber',
    'issuingCountry',
    'documentExpiry',
    'documentIssueDate',
    'streetAddress',
    'city',
    'postalCode',
    'country',
    'isOver18',
    'isOver21',
    'isOver65',
    'isEuCitizen',
    'isResident',
    'email',
    'emailVerified',
    'verificationLevel',
  ],
  'google-account': [
    'name',
    'email',
    'emailVerified',
    'pictureUrl',
    'locale',
    'hostedDomain',
    'verificationLevel',
  ],
  'apple-id': ['name', 'email', 'emailVerified', 'isPrivateEmail', 'verificationLevel'],
  'generic-oidc': [
    'name',
    'email',
    'emailVerified',
    'pictureUrl',
    'locale',
    'hostedDomain',
    'verificationLevel',
  ],
}

function CredentialDetails({ credential }: { credential: WalletCredential }) {
  const order = CLAIM_ORDER[credential.cardShape.kind] ?? []
  const claimRows = order
    .map((k) => [k, (credential.verifiedClaims as Record<string, unknown>)[k]] as const)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')

  return (
    <>
      <Card className="border border-white/10 bg-card/40">
        <CardContent className="p-4 space-y-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            What this card shares ({claimRows.length})
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
            {claimRows.map(([k, v]) => (
              <div key={k} className="flex flex-col min-w-0">
                <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {humanize(k)}
                </dt>
                <dd className="font-mono text-white truncate" title={String(v)}>
                  {formatValue(v)}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <details className="group rounded-lg border border-white/10 bg-card/40 text-xs">
        <summary className="px-4 py-3 cursor-pointer text-muted-foreground hover:text-foreground list-none flex items-center justify-between">
          <span>Card details</span>
          <span className="text-[10px] opacity-60 group-open:rotate-180 transition-transform">
            ▾
          </span>
        </summary>
        <div className="px-4 pb-3 space-y-2">
          <Row label="Issued by" value={credential.issuer} mono />
          <Row label="Source" value={credential.providerId} />
          <Row label="Added" value={new Date(credential.issuedAt).toLocaleString()} />
          <Row label="Card ID" value={credential.credentialId} mono dim />
        </div>
      </details>
    </>
  )
}

function Row({
  label,
  value,
  mono,
  dim,
}: {
  label: string
  value: string
  mono?: boolean
  dim?: boolean
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`truncate ml-2 ${mono ? 'font-mono' : ''} ${dim ? 'text-white/70' : 'text-white'}`}
      >
        {value}
      </span>
    </div>
  )
}

function humanize(camel: string): string {
  return camel.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
}

function formatValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'string' && v.length > 80) return v.slice(0, 77) + '…'
  return String(v)
}
