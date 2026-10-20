import type { ReactNode } from 'react'
import { AppShell, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { IconMessages, IconPlug, IconRobot, IconServer } from '@tabler/icons-react'
import { useHashRoute } from './router'

export const routes = [
  { route: '/agents', label: 'Agents', icon: IconRobot },
  { route: '/providers', label: 'Providers', icon: IconServer },
  { route: '/mcp', label: 'MCP', icon: IconPlug },
  { route: '/chat', label: 'Chat', icon: IconMessages },
]

const RAIL = 56
const PANEL = 280

function Rail() {
  const current = useHashRoute()
  return (
    <Stack w={RAIL} align="center" gap={4} py="sm" style={{ borderRight: '1px solid var(--mantine-color-default-border)', flexShrink: 0 }}>
      {routes.map(({ route, label, icon: Icon }) => (
        <Tooltip key={route} label={label} position="right" withArrow>
          <UnstyledButton
            onClick={() => { window.location.hash = route }}
            aria-label={label}
            w={40} h={40}
            style={{
              display: 'grid', placeItems: 'center', borderRadius: 8,
              background: current === route ? 'var(--mantine-color-default-hover)' : undefined,
            }}
          >
            <Icon size={20} stroke={1.5} />
          </UnstyledButton>
        </Tooltip>
      ))}
    </Stack>
  )
}

// every screen's frame: the rail, the screen's own list beside it (if it
// has one), a header with its title and whatever goes on the right, and main
export function ScreenLayout({ title, headerRight, navbar, children }: {
  title: string
  headerRight?: ReactNode
  navbar?: ReactNode
  children: ReactNode
}) {
  return (
    <AppShell header={{ height: 48 }} navbar={{ width: navbar ? RAIL + PANEL : RAIL, breakpoint: 0 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Text fw={600}>{title}</Text>
          {headerRight}
        </Group>
      </AppShell.Header>
      <AppShell.Navbar>
        <Group h="100%" gap={0} align="stretch" wrap="nowrap">
          <Rail />
          {navbar && <Stack w={PANEL} gap={0} style={{ overflow: 'hidden' }}>{navbar}</Stack>}
        </Group>
      </AppShell.Navbar>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  )
}
