import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import '../styles/autofill.css'
import { Autofill } from './Autofill'

createRoot(document.getElementById('root')!).render(<Autofill />)
