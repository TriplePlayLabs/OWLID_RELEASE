import { CheckCircle } from 'lucide-react'

interface StepCardProps {
  isActive: boolean
  isCompleted?: boolean
  isDisabled?: boolean
  icon: React.ReactNode
  title: string
  description: string
  children?: React.ReactNode
}

export function StepCard({
  isActive,
  isCompleted,
  isDisabled,
  icon,
  title,
  description,
  children,
}: StepCardProps) {
  return (
    <div
      className={`relative flex gap-4 transition-opacity duration-300 ${
        isDisabled ? 'pointer-events-none grayscale opacity-50' : 'opacity-100'
      }`}
    >
      {/* Step indicator */}
      <div className="flex flex-col items-center shrink-0 pt-5">
        <div
          className={`w-3 h-3 rounded-full border-2 transition-colors duration-300
            ${
              isCompleted
                ? 'border-green-500 bg-green-500'
                : isActive
                  ? 'border-white bg-transparent'
                  : 'border-white/20 bg-transparent'
            }`}
        />
        <div className="w-0.5 flex-1 bg-white/10 mt-2" />
      </div>

      {/* Card */}
      <div
        className={`flex-1 rounded-xl border border-white/10 bg-card/50 p-4 transition-all duration-300
          ${
            isActive
              ? 'ring-1 ring-white/20 shadow-[0_0_30px_-10px_rgba(255,255,255,0.1)]'
              : 'opacity-80 hover:opacity-100'
          }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-md bg-white/5 ${
                isActive ? 'text-white' : 'text-muted-foreground'
              }`}
            >
              {icon}
            </div>
            <div>
              <h3 className="text-base font-medium">{title}</h3>
              {isActive && <p className="text-xs text-muted-foreground/80 mt-0.5">{description}</p>}
            </div>
          </div>
          {isCompleted && <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />}
        </div>

        {/* Children expand/collapse via the CSS `grid-rows-[0fr→1fr]`
            trick — animates intrinsic content height without JS, falls
            back gracefully on browsers that haven't shipped the
            keyword `1fr` for grid track interpolation. */}
        {children && (
          <div
            className={`grid transition-all duration-300 ease-out ${
              isActive ? 'grid-rows-[1fr] opacity-100 mt-4' : 'grid-rows-[0fr] opacity-0 mt-0'
            }`}
            aria-hidden={!isActive}
          >
            <div className="overflow-hidden">{children}</div>
          </div>
        )}
      </div>
    </div>
  )
}
