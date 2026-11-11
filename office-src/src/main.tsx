// Phase 1a Deck port: no runtime /config fetch and no viewer or token handling.
// The iframe renders the scene straight away; the Deck supplies state later (HERMES-BRIDGE).
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
