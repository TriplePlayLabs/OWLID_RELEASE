import { motion, AnimatePresence } from 'framer-motion'
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
    <motion.div
      initial={false}
      animate={{ opacity: isDisabled ? 0.5 : 1 }}
      className={`relative flex gap-4 ${isDisabled ? 'pointer-events-none grayscale' : ''}`}
    >
      {/* Step indicator */}
      <div className="flex flex-col items-center shrink-0 pt-5">
        <div
          className={`w-3 h-3 rounded-full border-2 transition-colors duration-300
            ${isCompleted ? 'border-green-500 bg-green-500' : isActive ? 'border-white bg-transparent' : 'border-white/20 bg-transparent'}`}
        />
        <div className="w-0.5 flex-1 bg-white/10 mt-2" />
      </div>

      {/* Card */}
      <div
        className={`flex-1 rounded-xl border border-white/10 bg-card/50 p-4 transition-all duration-300
          ${isActive ? 'ring-1 ring-white/20 shadow-[0_0_30px_-10px_rgba(255,255,255,0.1)]' : 'opacity-80 hover:opacity-100'}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-md bg-white/5 ${isActive ? 'text-white' : 'text-muted-foreground'}`}
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

        <AnimatePresence>
          {isActive && children && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              <div className="mt-4">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
