const Owl = () => {
  return (
    <div className="owl-container origin-center">
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
  )
}

export default Owl
