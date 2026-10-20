import '@cmdless/ui-sdk/browser' // installs window.cmdless's global type augmentation
import '@mantine/core/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { HangarProvider } from './hangar'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <HangarProvider>
        <App />
      </HangarProvider>
    </MantineProvider>
  </StrictMode>,
)
