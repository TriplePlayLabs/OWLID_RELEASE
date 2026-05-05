import { motion } from 'framer-motion'

export const PureCSSLogo = () => {
  return (
    <motion.div
      className="relative w-12 h-12 flex items-center justify-center"
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5 }}
    >
      {/* Outer Ring */}
      <div className="absolute inset-0 border-2 border-white/20 rounded-full" />

      {/* Rotating Arc */}
      <motion.div
        className="absolute inset-0 border-2 border-t-transparent border-r-transparent border-b-white border-l-white rounded-full"
        animate={{ rotate: 360 }}
        transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
      />

      {/* Inner Core */}
      <div className="w-6 h-6 bg-white rounded-sm rotate-45 shadow-[0_0_15px_rgba(255,255,255,0.5)]" />
    </motion.div>
  )
}
