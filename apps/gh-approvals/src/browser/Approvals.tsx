import { useEffect, useMemo, useState } from 'react';
import { AppShell, Badge, Card, Group, NavLink, ScrollArea, SimpleGrid, Stack, Tabs, Text, Title } from '@mantine/core';
import { approvalsProtocol } from '../shared/protocols';
import type { Device } from '../shared/protocols';
import type { Item } from '../shared/items';
import { useBackend, useChannel } from './backend';

type Kind = Item['kind'];

// the approvals window: every device the tray knows of down the side, and the
// one picked's items - pull requests or deployments - grouped by repository
export default function Approvals() {
  const { client, error } = useBackend(approvalsProtocol);
  const devices = useChannel(client?.state.devices);
  const status = useChannel(client?.state.status);
  const [selected, setSelected] = useState<string>();

  // this tray's own first, then everyone else's by whose it is
  const listed = useMemo(() => Object.entries(devices ?? {}).sort(([a, one], [b, two]) =>
    Number(b === status?.deviceId) - Number(a === status?.deviceId) || one.user.localeCompare(two.user)),
  [devices, status?.deviceId]);

  // the one picked, while it's there - this tray's own otherwise
  const current = selected && devices?.[selected] ? selected : status?.deviceId;
  useEffect(() => { if (selected && devices && !devices[selected]) setSelected(undefined); }, [devices, selected]);

  if (error) return <Text c="red" p="md">{error}</Text>;
  if (!devices || !status) return null;

  return (
    <AppShell navbar={{ width: 240, breakpoint: 0 }} padding={0}>
      <AppShell.Navbar>
        <ScrollArea p="xs">
          {listed.map(([deviceId, device]) => (
            <NavLink
              key={deviceId}
              active={deviceId === current}
              onClick={() => setSelected(deviceId)}
              label={device.user}
              description={deviceId === status.deviceId ? `this device${status.online ? '' : ', offline'}` : undefined}
              rightSection={<Badge size="sm" variant="light">{Object.keys(device.items).length}</Badge>}
            />
          ))}
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main h="100dvh" style={{ display: 'flex', flexDirection: 'column' }}>
        {current && devices[current] && <DeviceItems device={devices[current]} />}
      </AppShell.Main>
    </AppShell>
  );
}

const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'pull-request', label: 'Pull Requests' },
  { kind: 'deployment', label: 'Deployments' },
];

// a device's items, a tab per kind
function DeviceItems({ device }: { device: Device }) {
  const items = Object.values(device.items);
  return (
    <Tabs defaultValue="pull-request" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Tabs.List px="md">
        {KINDS.map(({ kind, label }) => (
          <Tabs.Tab key={kind} value={kind}>{label} ({items.filter(item => item.kind === kind).length})</Tabs.Tab>
        ))}
      </Tabs.List>
      {KINDS.map(({ kind }) => (
        <Tabs.Panel key={kind} value={kind} style={{ flex: 1, minHeight: 0 }}>
          <ScrollArea h="100%">
            <Repos items={items.filter(item => item.kind === kind)} />
          </ScrollArea>
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

// a card per repository, with a card per item in it
function Repos({ items }: { items: Item[] }) {
  const byRepo = new Map<string, Item[]>();
  for (const item of items) byRepo.set(item.repo, [...byRepo.get(item.repo) ?? [], item]);
  const repos = [...byRepo].sort(([a], [b]) => a.localeCompare(b));

  if (!repos.length) return <Text c="dimmed" p="md">Nothing waiting.</Text>;
  return (
    <Stack p="md">
      {repos.map(([repo, inRepo]) => (
        <Card key={repo} withBorder>
          <Card.Section withBorder inheritPadding py="xs">
            <Title order={5}>{repo}</Title>
          </Card.Section>
          <Card.Section inheritPadding py="sm">
            <Stack>
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
                {inRepo.sort((a, b) => a.number - b.number).map(item => <ItemCard key={item.url} item={item} />)}
              </SimpleGrid>
            </Stack>
          </Card.Section>
        </Card>
      ))}
    </Stack>
  );
}

// one pull request or deployment
function ItemCard({ item }: { item: Item }) {
  return (
    <Card withBorder padding="sm">
      <Text fw={500} lineClamp={2}>#{item.number} {item.title}</Text>
      <Group gap="xs" mt="xs">
        {item.kind === 'pull-request'
          ? <>
            <Text size="sm" c="dimmed">{item.author}</Text>
            {item.othersOnly && <Badge size="sm" color="orange" variant="light">needs someone else</Badge>}
          </>
          : item.environments.map(environment => <Badge key={environment.id} size="sm" variant="light">{environment.name}</Badge>)}
      </Group>
    </Card>
  );
}
