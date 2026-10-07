import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import '../styles/swipe.css'
import { SwipeArrow } from './SwipeArrow'

createRoot(document.getElementById('root')!).render(<SwipeArrow />)
