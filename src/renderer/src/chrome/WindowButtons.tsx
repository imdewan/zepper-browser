import { zepper } from '../bridge'

/**
 * Linux: the window's minimise, maximise and close buttons, at the end of the sidebar's top row
 * (macOS draws its traffic lights at the start instead). Round, as GNOME's are.
 */
export function WindowButtons({ maximized }: { maximized: boolean }): React.JSX.Element {
  return (
    <span className="window-buttons">
      <button className="window-button" title="Minimise" onClick={() => zepper.send({ type: 'window.minimize' })}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 5h7" />
        </svg>
      </button>
      <button className="window-button" title={maximized ? 'Restore' : 'Maximise'} onClick={() => zepper.send({ type: 'window.maximize' })}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          {maximized ? <path d="M3 1.5h5.5V7M1.5 3h5.5v5.5H1.5z" /> : <rect x="1.5" y="1.5" width="7" height="7" rx="0.6" />}
        </svg>
      </button>
      <button className="window-button" title="Close" onClick={() => zepper.send({ type: 'window.close' })}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 2l6 6M8 2l-6 6" />
        </svg>
      </button>
    </span>
  )
}
