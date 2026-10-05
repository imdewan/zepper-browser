import { Fragment, memo } from 'react'
import { motion } from 'motion/react'
import type { Split, Tab } from '@shared/types'
import { zepper } from '../bridge'
import { Favicon } from '../Favicon'
import { cx } from '../util'

interface SplitRowProps {
  split: Split
  tabs: Tab[]
  activeTabId: string | null
}

/** A split view in the sidebar: its tabs side by side in one row. */
export const SplitRow = memo(function SplitRow({ split, tabs, activeTabId }: SplitRowProps): React.JSX.Element {
  const active = !!activeTabId && split.tabIds.includes(activeTabId)
  return (
    <motion.div
      className="tab-wrap"
      layout="position"
      initial={{ opacity: 0, height: 0, scale: 0.95 }}
      animate={{ opacity: 1, height: 'auto', scale: 1 }}
      exit={{ opacity: 0, height: 0, scale: 0.95, transition: { duration: 0.1 } }}
      transition={{ duration: 0.12, ease: 'easeOut' }}
    >
      <div className={cx('split-row', active && 'active', split.layout)} title="Split view">
        {tabs.map((tab, i) => (
          <Fragment key={tab.id}>
            {i > 0 && <span className="split-divider" />}
            <div
              className={cx('split-cell', tab.id === activeTabId && 'focused')}
              title={tab.title}
              onClick={() => zepper.send({ type: 'tab.activate', tabId: tab.id })}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => e.button === 1 && zepper.send({ type: 'tab.middleClick', tabId: tab.id })}
              onContextMenu={(e) => {
                e.preventDefault()
                zepper.send({ type: 'tab.contextMenu', tabId: tab.id })
              }}
            >
              <Favicon src={tab.favicon} size={14} />
              <span className="split-title">{tab.title || tab.url}</span>
            </div>
          </Fragment>
        ))}
      </div>
    </motion.div>
  )
})
