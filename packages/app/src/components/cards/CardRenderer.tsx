import type { WalletCredential } from '@owlid/sdk'
import { PassportCard } from './PassportCard'
import { GoogleAccountCard } from './GoogleAccountCard'
import { AppleIdCard } from './AppleIdCard'
import { GenericOidcCard } from './GenericOidcCard'

interface CardRendererProps {
  credential: WalletCredential
  onClick?: () => void
}

/** Pick the per-IdP card component from `credential.cardShape.kind`. */
export function CardRenderer({ credential, onClick }: CardRendererProps) {
  switch (credential.cardShape.kind) {
    case 'passport':
      return <PassportCard credential={credential} onClick={onClick} />
    case 'google-account':
      return <GoogleAccountCard credential={credential} onClick={onClick} />
    case 'apple-id':
      return <AppleIdCard credential={credential} onClick={onClick} />
    case 'generic-oidc':
      return <GenericOidcCard credential={credential} onClick={onClick} />
  }
}
