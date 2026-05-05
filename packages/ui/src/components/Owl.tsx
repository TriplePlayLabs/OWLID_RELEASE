interface OwlProps {
  // Outer pixel size of the rendered owl. The internal markup is fixed at
  // 150px (see `.owl-container` in styles.css); we scale via CSS transform
  // and clip the bounding box so smaller sizes don't leave whitespace.
  size?: number
  className?: string
}

const NATIVE_SIZE = 150

const Owl = ({ size = NATIVE_SIZE, className }: OwlProps) => {
  const scale = size / NATIVE_SIZE
  const wrapperStyle: React.CSSProperties = { width: size, height: size }
  const innerStyle: React.CSSProperties =
    scale === 1
      ? {}
      : {
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }

  return (
    <div className={className} style={wrapperStyle}>
      <div className="owl-container origin-center" style={innerStyle}>
        <div className="owl">
          <div className="owl-wings">
            <div className="owl-wing owl-wing-left"></div>
            <div className="owl-wing owl-wing-right"></div>
          </div>
          <div className="owl-body">
            <div className="owl-abdomen"></div>
          </div>
          <div className="owl-head">
            <div className="owl-eyes">
              <div className="owl-eye owl-eye-left">
                <div className="owl-eye-core"></div>
              </div>
              <div className="owl-eye owl-eye-right">
                <div className="owl-eye-core"></div>
              </div>
            </div>
            <div className="owl-beak"></div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Owl
