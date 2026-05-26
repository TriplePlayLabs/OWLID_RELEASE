import type { VerifiedClaims } from '@owlid/sdk'
import { buildTd3Mrz, toAlpha3 } from '~/utils/mrz'

interface PassportDataPageProps {
  claims: VerifiedClaims
  portraitImage?: string
}

function getPortraitSrc(portraitImage?: string): string | undefined {
  if (!portraitImage) return undefined
  if (portraitImage.startsWith('http://') || portraitImage.startsWith('https://'))
    return portraitImage
  if (portraitImage.startsWith('data:')) return portraitImage
  return `data:image/jpeg;base64,${portraitImage}`
}

function getInitials(firstName?: string, lastName?: string): string {
  const first = firstName?.[0]?.toUpperCase() || ''
  const last = lastName?.[0]?.toUpperCase() || ''
  return `${first}${last}` || '?'
}

function up(s?: string): string {
  return (s ?? '').trim().toUpperCase() || '—'
}

/** ICAO sex code: M / F / X (unspecified). */
function sexCode(gender?: string): string {
  const g = (gender ?? '').trim().toLowerCase()
  if (g.startsWith('m')) return 'M'
  if (g.startsWith('f')) return 'F'
  return 'X'
}

/** One ICAO data-page field — caption above the value. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[8px] uppercase tracking-[0.1em] text-zinc-500">{label}</div>
      <div className="truncate font-mono text-[13.5px] font-semibold uppercase leading-tight text-zinc-900">
        {value}
      </div>
    </div>
  )
}

/**
 * ICAO 9303 TD3 passport data page — fills the (portrait) back face of
 * the passport card once it flips open. Header, photograph + the
 * primary field column, the remaining fields, then the machine-readable
 * zone pinned to the foot. Self-contained styling: it is the flip-card
 * back, so it must not re-apply any page rotation of its own.
 */
export function PassportDataPage({ claims, portraitImage }: PassportDataPageProps) {
  const c = claims
  const portraitSrc = getPortraitSrc(portraitImage ?? c.portraitImage)
  const initials = getInitials(c.firstName, c.lastName)
  const docNumber = (c.passportNumber || c.documentNumber || c.nationalId || '—').toUpperCase()
  const issuingState = toAlpha3(c.issuingCountry || c.nationality || '')
  const nationality3 = toAlpha3(c.nationality || c.issuingCountry || '')
  const mrz = buildTd3Mrz(c)

  return (
    <div className="absolute inset-0 flex flex-col bg-[#fdfbf7] p-5 text-zinc-900 [container-type:inline-size]">
      {/* Header — issuing state · title · document type */}
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-900/70 pb-2">
        <div className="font-mono text-[12px] font-bold tracking-[0.14em] text-zinc-800">
          {issuingState}
        </div>
        <div className="text-[14px] font-bold tracking-[0.22em] text-zinc-900">PASSPORT</div>
        <div className="font-mono text-[12px] font-bold tracking-[0.14em] text-zinc-800">P</div>
      </div>

      {/* Photograph + primary identity fields beside it */}
      <div className="mt-4 flex shrink-0 gap-3.5">
        <div className="h-[160px] w-[122px] shrink-0 overflow-hidden rounded-[2px] border border-zinc-400 bg-zinc-200">
          {portraitSrc ? (
            <img
              src={portraitSrc}
              alt={`${c.firstName ?? ''} ${c.lastName ?? ''}`.trim()}
              className="h-full w-full object-cover [filter:grayscale(1)_contrast(1.05)]"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-200 to-zinc-300 text-3xl font-bold text-zinc-500">
              {initials}
            </div>
          )}
        </div>
        <div className="flex flex-1 flex-col justify-between py-0.5">
          <Field label="Passport No." value={docNumber} />
          <Field label="Surname" value={up(c.lastName)} />
          <Field label="Given names" value={up(c.firstName)} />
          <Field label="Nationality" value={nationality3} />
        </div>
      </div>

      {/* Remaining fields — full width, natural spacing */}
      <div className="mt-4 grid shrink-0 grid-cols-2 gap-x-3.5 gap-y-4 border-t border-zinc-300 pt-4">
        <Field label="Date of birth" value={c.dateOfBirth || '—'} />
        <Field label="Sex" value={sexCode(c.gender)} />
        <Field label="Place of birth" value={up(c.placeOfBirth)} />
        <Field label="Date of issue" value={c.documentIssueDate || '—'} />
        <Field label="Date of expiry" value={c.documentExpiry || '—'} />
      </div>

      {/* Machine-readable zone — pinned to the foot of the page */}
      <div className="mt-auto shrink-0 border-t border-zinc-900/70 pt-2">
        <div className="mrz-line">{mrz.line1}</div>
        <div className="mrz-line">{mrz.line2}</div>
      </div>
    </div>
  )
}
