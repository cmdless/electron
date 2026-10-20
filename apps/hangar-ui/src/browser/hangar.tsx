import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { Center, Loader, Text } from '@mantine/core'
import { useHangar } from './useHangar'
import type { HangarClient } from './useHangar'

const HangarContext = createContext<HangarClient | undefined>(undefined)

// one connection to hangar, shared by every screen
export function HangarProvider({ children }: { children: ReactNode }) {
  const { client, error } = useHangar()
  if (error) return <Center h="100vh"><Text c="red">{error}</Text></Center>
  if (!client) return <Center h="100vh"><Loader size="sm" /></Center>
  return <HangarContext.Provider value={client}>{children}</HangarContext.Provider>
}

export function useHangarClient() {
  const client = useContext(HangarContext)
  if (!client) throw new Error('useHangarClient needs a HangarProvider')
  return client
}
