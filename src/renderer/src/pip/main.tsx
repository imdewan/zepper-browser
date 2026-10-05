import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import '../styles/pip.css'
import { PipControls } from './PipControls'

createRoot(document.getElementById('root')!).render(<PipControls />)
