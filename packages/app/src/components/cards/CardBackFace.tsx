import type { ReactNode } from 'react'
import type { VerifiedClaims, WalletCredential } from '@owlid/sdk'
import { getBrandIcon } from '~/components/identity/ProviderBrandIcon'
import { PassportDataPage } from '~/components/identity/PassportDataPage'

interface BackFaceProps {
  credential: WalletCredential
}

/**
 * Tone definitions matched 1:1 with the front-face gradients per IdP so
 * the flip feels like turning the same card over, not opening a second
 * card. Tailwind class strings; kept inline so the bundle keeps every
 * variant.
 */
const TONES: Record<string, { ring: string; gradient: string; accent: string; label: string }> = {
  google: {
    ring: 'border-sky-500/30',
    gradient: 'bg-zinc-950 bg-gradient-to-br from-sky-950 via-slate-900 to-zinc-950',
    accent: 'text-sky-200',
    label: 'text-sky-200/60',
  },
  apple: {
    ring: 'border-zinc-400/30',
    gradient: 'bg-zinc-950 bg-gradient-to-br from-zinc-800 via-stone-900 to-zinc-950',
    accent: 'text-white/85',
    label: 'text-white/50',
  },
  microsoft: {
    ring: 'border-indigo-500/30',
    gradient: 'bg-zinc-950 bg-gradient-to-br from-indigo-950 via-slate-900 to-zinc-950',
    accent: 'text-indigo-200',
    label: 'text-indigo-200/60',
  },
  default: {
    ring: 'border-indigo-500/30',
    gradient: 'bg-zinc-950 bg-gradient-to-br from-indigo-950 via-slate-900 to-zinc-950',
    accent: 'text-indigo-200',
    label: 'text-indigo-200/60',
  },
}

function toneFor(providerId: string) {
  return TONES[providerId.toLowerCase()] ?? TONES.default
}

function humanize(camel: string): string {
  return camel.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
}

function formatValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'string' && v.length > 80) return v.slice(0, 77) + '…'
  return String(v)
}

/**
 * Pick a small subset of the disclosed claims for the back face. We
 * cap at ~6 rows so the card stays readable at the credit-card aspect
 * ratio; the wallet detail page shows the full claim list below.
 */
function highlightedClaims(c: VerifiedClaims, providerId: string): [string, unknown][] {
  const pref =
    providerId === 'google' || providerId === 'apple'
      ? ['name', 'email', 'emailVerified', 'locale', 'hostedDomain', 'verificationLevel']
      : [
          'firstName',
          'lastName',
          'email',
          'nationality',
          'documentType',
          'documentNumber',
          'verificationLevel',
        ]
  return pref
    .map((k) => [k, (c as Record<string, unknown>)[k]] as [string, unknown])
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .slice(0, 6)
}

function FrameHeader({ providerId, brandLabel }: { providerId: string; brandLabel: string }) {
  const Brand = getBrandIcon(providerId)
  return (
    <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-white/60">
      {Brand ? (
        <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-white">
          <Brand className="w-3.5 h-3.5" />
        </span>
      ) : null}
      <span>{brandLabel}</span>
    </div>
  )
}

function OidcBackFace({ credential, brandLabel }: BackFaceProps & { brandLabel: string }) {
  const tone = toneFor(credential.providerId)
  const rows = highlightedClaims(credential.verifiedClaims, credential.providerId)
  return (
    <div
      className={`h-full w-full ${tone.gradient} ${tone.ring} border rounded-2xl p-5 flex flex-col gap-4`}
    >
      <FrameHeader providerId={credential.providerId} brandLabel={brandLabel} />
      <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs flex-1 content-start">
        {rows.length === 0 && (
          <div className={`col-span-2 text-xs ${tone.label}`}>No claims disclosed.</div>
        )}
        {rows.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className={`text-[10px] uppercase tracking-wider ${tone.label}`}>{humanize(k)}</dt>
            <dd className={`mt-0.5 truncate font-mono text-white`} title={String(v)}>
              {formatValue(v)}
            </dd>
          </div>
        ))}
      </dl>
      <div className={`text-[10px] ${tone.label} truncate`}>cred {credential.credentialId}</div>
    </div>
  )
}

/**
 * Dispatch by card kind. Passport keeps the rich passport data page
 * (with MRZ + portrait). Every OIDC variant shares the back-face frame
 * but inherits its brand gradient + accent colours.
 */
export function CardBackFace({ credential }: BackFaceProps): ReactNode {
  const kind = credential.cardShape.kind
  if (kind === 'passport') {
    const portraitImage = credential.cardShape.portraitImage
    return <PassportDataPage claims={credential.verifiedClaims} portraitImage={portraitImage} />
  }
  if (kind === 'google-account') {
    return <OidcBackFace credential={credential} brandLabel="Google Account" />
  }
  if (kind === 'apple-id') {
    return <OidcBackFace credential={credential} brandLabel="Apple ID" />
  }
  const brand = kind === 'generic-oidc' ? credential.cardShape.brandName : credential.providerId
  return <OidcBackFace credential={credential} brandLabel={brand} />
}
