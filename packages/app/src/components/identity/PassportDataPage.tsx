import type { IdentityData } from '@owlid/sdk'

interface PassportDataPageProps {
  identityData: IdentityData | null
}

/**
 * Get the portrait image source.
 * Handles URLs (http/https), data URIs, or raw base64.
 */
function getPortraitSrc(portraitImage?: string): string | undefined {
  if (!portraitImage) return undefined

  // If it's an HTTP(S) URL, use as-is
  if (portraitImage.startsWith('http://') || portraitImage.startsWith('https://')) {
    return portraitImage
  }

  // If it already has a data URI prefix, use as-is
  if (portraitImage.startsWith('data:')) {
    return portraitImage
  }

  // Otherwise, assume it's raw base64 and add JPEG prefix (most common for ID photos)
  return `data:image/jpeg;base64,${portraitImage}`
}

/**
 * Get initials from name for fallback display
 */
function getInitials(firstName?: string, lastName?: string): string {
  const first = firstName?.[0]?.toUpperCase() || ''
  const last = lastName?.[0]?.toUpperCase() || ''
  return `${first}${last}` || '?'
}

export function PassportDataPage({ identityData }: PassportDataPageProps) {
  if (!identityData) {
    return (
      <div className="passport-page overflow-y-auto custom-scrollbar">
        <p className="text-center text-muted-foreground py-8">No identity data available.</p>
      </div>
    )
  }

  const portraitSrc = getPortraitSrc(identityData.portraitImage)
  const initials = getInitials(identityData.firstName, identityData.lastName)

  return (
    <div className="passport-page overflow-y-auto custom-scrollbar">
      <div className="data-page-header shrink-0">
        <span className="data-page-type">P</span>
        <span className="data-page-code">
          {identityData.nationality?.slice(0, 3).toUpperCase() || 'USA'}
        </span>
        <span className="data-page-code">
          {identityData.passportNumber || identityData.nationalId || '---'}
        </span>
      </div>

      <div className="data-grid">
        <div className="photo-area">
          {portraitSrc ? (
            <img
              src={portraitSrc}
              alt={`Portrait of ${identityData.firstName} ${identityData.lastName}`}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-200 to-gray-300 text-gray-600 font-bold text-3xl">
              {initials}
            </div>
          )}
        </div>

        <div className="details-area">
          <div className="detail-group">
            <span className="detail-label">Surname / Nom</span>
            <span className="detail-value">
              {(identityData.lastName ?? '').toUpperCase() || '---'}
            </span>
          </div>
          <div className="detail-group">
            <span className="detail-label">Given Names / Prénoms</span>
            <span className="detail-value">
              {(identityData.firstName ?? '').toUpperCase() || '---'}
            </span>
          </div>
          <div className="detail-group">
            <span className="detail-label">Nationality / Nationalité</span>
            <span className="detail-value">{identityData.nationality || '---'}</span>
          </div>
          <div className="detail-group">
            <span className="detail-label">Date of Birth / Date de naissance</span>
            <span className="detail-value">{identityData.birthDate || '---'}</span>
          </div>
        </div>
      </div>

      {/* Extended Digital Attributes */}
      <div className="mt-6 pt-4 border-t-2 border-black/5 space-y-4 shrink-0">
        <div className="flex items-center gap-2 opacity-50 mb-2">
          <div className="h-px bg-black flex-1"></div>
          <span className="text-[8px] uppercase tracking-widest font-bold text-black">
            Digital Identity Extensions
          </span>
          <div className="h-px bg-black flex-1"></div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <div className="detail-group">
            <span className="detail-label">National ID</span>
            <span className="detail-value text-xs">{identityData.nationalId}</span>
          </div>
          <div className="detail-group">
            <span className="detail-label">Tax ID</span>
            <span className="detail-value text-xs">{identityData.taxId}</span>
          </div>
          <div className="detail-group">
            <span className="detail-label">Credit Score</span>
            <span className="detail-value text-xs text-emerald-700">
              {identityData.creditScore} (EXCELLENT)
            </span>
          </div>
          <div className="detail-group">
            <span className="detail-label">Occupation</span>
            <span className="detail-value text-xs leading-tight">{identityData.occupation}</span>
          </div>
          <div className="detail-group col-span-2">
            <span className="detail-label">Address</span>
            <span className="detail-value text-xs leading-tight">{identityData.address}</span>
          </div>
          <div className="detail-group">
            <span className="detail-label">Email</span>
            <span className="detail-value text-xs lowercase leading-tight break-all">
              {identityData.email}
            </span>
          </div>
          <div className="detail-group">
            <span className="detail-label">Phone</span>
            <span className="detail-value text-xs">{identityData.phone}</span>
          </div>
        </div>
      </div>

      <div className="mrz-area shrink-0 mt-8 pb-4">
        P&lt;{(identityData.nationality ?? '').slice(0, 3).toUpperCase() || 'XXX'}
        {(identityData.lastName ?? '').toUpperCase() || 'UNKNOWN'}&lt;&lt;
        {(identityData.firstName ?? '').toUpperCase() || 'UNKNOWN'}
        &lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;&lt;
        <br />
        {identityData.passportNumber || identityData.nationalId || 'XXXXXXXXX'}
        &lt;{(identityData.nationality ?? '').slice(0, 3).toUpperCase() || 'XXX'}&lt;
        {(identityData.birthDate ?? '').replace(/-/g, '') || 'XXXXXXXX'}&lt;&lt;&lt;&lt;&lt;&lt;
      </div>
    </div>
  )
}
