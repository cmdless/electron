import '@cmdless/ui-sdk/browser' // installs window.cmdless's global type augmentation, and vscode-jsonrpc's browser runtime
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
