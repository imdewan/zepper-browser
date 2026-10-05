import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import '../styles/chrome.css'
import '../styles/overlay.css'
import { Overlay } from './Overlay'

createRoot(document.getElementById('root')!).render(<Overlay />)
