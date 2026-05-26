import type { ReactElement, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { className?: string }

// Brand marks (Simple Icons style) — inline so we don't pull in another
// dependency. Pure SVG, sized from `className`.

function GoogleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
        fill="#EA4335"
      />
    </svg>
  )
}

function MicrosoftIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path d="M11.4 11.4H1V1h10.4v10.4z" fill="#F25022" />
      <path d="M23 11.4H12.6V1H23v10.4z" fill="#7FBA00" />
      <path d="M11.4 23H1V12.6h10.4V23z" fill="#00A4EF" />
      <path d="M23 23H12.6V12.6H23V23z" fill="#FFB900" />
    </svg>
  )
}

function AppleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path
        d="M17.05 12.04c-.03-3.05 2.49-4.51 2.6-4.59-1.42-2.08-3.63-2.36-4.42-2.39-1.88-.19-3.67 1.11-4.62 1.11-.97 0-2.43-1.08-3.99-1.05-2.05.03-3.95 1.19-5.01 3.03-2.14 3.7-.55 9.18 1.53 12.18 1.02 1.47 2.23 3.12 3.81 3.06 1.53-.06 2.11-.99 3.96-.99 1.85 0 2.37.99 3.99.96 1.65-.03 2.69-1.5 3.69-2.98 1.17-1.71 1.65-3.36 1.68-3.45-.04-.02-3.22-1.24-3.22-4.89zM14.05 3.43c.84-1.02 1.41-2.43 1.25-3.83-1.21.05-2.68.81-3.55 1.82-.78.9-1.46 2.34-1.28 3.72 1.35.1 2.74-.69 3.58-1.71z"
        fill="currentColor"
      />
    </svg>
  )
}

function GitHubIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <path
        d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.87-1.54-3.87-1.54-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.92-.39 2.9-.39.98 0 1.98.13 2.9.39 2.21-1.49 3.18-1.18 3.18-1.18.62 1.58.23 2.75.11 3.04.74.8 1.18 1.83 1.18 3.09 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.67.79.56 4.57-1.52 7.86-5.83 7.86-10.91C23.5 5.65 18.35.5 12 .5z"
        fill="currentColor"
      />
    </svg>
  )
}

const BRAND_ICONS: Record<string, (props: IconProps) => ReactElement> = {
  google: GoogleIcon,
  microsoft: MicrosoftIcon,
  apple: AppleIcon,
  github: GitHubIcon,
}

export function getBrandIcon(providerId: string): ((props: IconProps) => ReactElement) | null {
  return BRAND_ICONS[providerId.toLowerCase()] ?? null
}
