import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { holdSessionLease } from '@/lib/apiClient'
import './index.css'

// Tell the review server this tab exists, and keep telling it. Once the lease has been gone for the
// grace period the CLI records the session as abandoned, which is how a closed tab ends the run.
holdSessionLease()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
