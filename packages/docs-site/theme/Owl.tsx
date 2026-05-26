import { type CSSProperties } from 'react'

const NATIVE_SIZE = 150

interface OwlProps {
  size?: number
  className?: string
}

export function Owl({ size = NATIVE_SIZE, className }: OwlProps) {
  const scale = size / NATIVE_SIZE
  const wrapperStyle: CSSProperties = { width: size, height: size, flexShrink: 0 }
  const innerStyle: CSSProperties =
    scale === 1 ? {} : { transform: `scale(${scale})`, transformOrigin: 'top left' }

  return (
    <div className={className} style={wrapperStyle}>
      <div className="owl-container" style={innerStyle}>
        <div className="owl">
          <div className="owl-wings">
            <div className="owl-wing owl-wing-left" />
            <div className="owl-wing owl-wing-right" />
          </div>
          <div className="owl-body">
            <div className="owl-abdomen" />
          </div>
          <div className="owl-head">
            <div className="owl-eyes">
              <div className="owl-eye owl-eye-left">
                <div className="owl-eye-core" />
              </div>
              <div className="owl-eye owl-eye-right">
                <div className="owl-eye-core" />
              </div>
            </div>
            <div className="owl-beak" />
          </div>
        </div>
      </div>
    </div>
  )
}

export default Owl
