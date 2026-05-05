import Owl from '~/components/Owl'

interface IdentityHeaderProps {
  onReset: () => void
}

export function IdentityHeader({ onReset }: IdentityHeaderProps) {
  return (
    <div className="mb-8 md:mb-12 flex flex-col items-center text-center w-full">
      <div
        className="flex flex-col items-center gap-2 mb-6 group cursor-pointer"
        onClick={onReset}
        title="Click to reset"
      >
        <Owl />
        <h1 className="text-3xl md:text-4xl font-bold tracking-tighter uppercase mt-2">Owl ID</h1>
      </div>
      <p className="text-muted-foreground text-lg leading-relaxed max-w-md mx-auto">
        Secure identity verification without passwords. Prove it's really you using your device.
      </p>
    </div>
  )
}
