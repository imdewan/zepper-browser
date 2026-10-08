import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { IconPopIn } from '../icons'
import { useSnapshot, useSystemDark } from '../useSnapshot'
import { hostOf } from '../util'

/**
 * The title bar of a page's floating call window (Meet, Teams, Zoom), as in Chrome: the traffic
 * lights, the call's site, and Back to tab. The call itself is drawn below it.
 */
export function CallBar(): React.JSX.Element {
  const tabId = new URLSearchParams(location.search).get('call') ?? ''
  const snapshot = useSnapshot()
  const dark = useSystemDark()
  const tab = snapshot?.tabs.find((t) => t.id === tabId)
  return (
    <div className="call-bar" data-ui={dark ? 'dark' : 'light'}>
      <div className="call-row">
        <Favicon src={tab?.favicon ?? null} size={14} />
        <span className="call-site">{tab ? hostOf(tab.url) : ''}</span>
        <button className="call-back" title="Back to tab" onClick={() => zepper.send({ type: 'call.back', tabId })}>
          <IconPopIn size={14} />
          <span className="call-back-label">Back to tab</span>
        </button>
      </div>
    </div>
  )
}
