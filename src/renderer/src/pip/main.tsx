import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import '../styles/pip.css'
import { CallBar } from './CallBar'
import { PipControls } from './PipControls'

// The floating video's controls, or the title bar of a page's floating call window.
const call = new URLSearchParams(location.search).has('call')
createRoot(document.getElementById('root')!).render(call ? <CallBar /> : <PipControls />)
