import { useState } from 'react';
import {
  Alert, Avatar, Badge, Button, Card, Group, Paper, SimpleGrid, Stack, Text, Title,
} from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import type { AgentEntry, RegistryAgent } from '@cmdless/hangar-sdk';
import { ScreenLayout } from '../layout';
import { useHangarClient } from '../hangar';
import { useChannel } from '../useHangar';
import type { HangarClient } from '../useHangar';

// what a registry agent can run as - hangar runs npx and uvx, not binaries yet
function runsAs(agent: RegistryAgent) {
  if (agent.distribution.npx) return 'npx';
  if (agent.distribution.uvx) return 'uvx';
  return undefined;
}

function useAction() {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    action().catch(reason => setError(String(reason?.message ?? reason))).finally(() => setBusy(false));
  };
  return { run, busy, error };
}

function StaleBanner({ hangar }: { hangar: HangarClient }) {
  const host = useChannel(hangar.state.host);
  const { run, busy, error } = useAction();
  if (!host?.stale) return null;
  return (
    <Alert color="violet" title="Agents changed since the host started">
      <Group>
        <Button size="xs" loading={busy} onClick={() => run(() => hangar.request.restart({}))}>Restart to apply</Button>
        {error && <Button size="xs" variant="default" disabled={busy} onClick={() => run(() => hangar.request.restart({ force: true }))}>Restart anyway</Button>}
      </Group>
      {error && <Text c="red" size="sm" mt="xs">{error}</Text>}
    </Alert>
  );
}

function Configured({ hangar }: { hangar: HangarClient }) {
  const agents = useChannel(hangar.state.agents);
  const registry = useChannel(hangar.state.registry);
  const host = useChannel(hangar.state.host);
  const { run, busy, error } = useAction();

  const describe = (entry: AgentEntry) => entry.kind === 'custom'
    ? { name: entry.name, detail: `${entry.command} ${(entry.args ?? []).join(' ')}` }
    : { name: registry?.agents[entry.registryId]?.name ?? entry.registryId, detail: `${entry.registryId}@${entry.version}` };

  return (
    <Stack gap="xs">
      <Title order={4}>Agents</Title>
      <Paper withBorder p="sm">
        <Group justify="space-between"><Text>Claude</Text><Badge variant="light">built in</Badge></Group>
      </Paper>
      {Object.values(agents ?? {}).map(entry => {
        const { name, detail } = describe(entry);
        const unavailable = host?.unavailable[entry.id];
        return (
          <Paper key={entry.id} withBorder p="sm">
            <Group justify="space-between" wrap="nowrap">
              <div>
                <Text>{name}</Text>
                <Text size="xs" c="dimmed">{detail}</Text>
                {unavailable && <Text size="xs" c="red">{unavailable}</Text>}
              </div>
              <Button size="xs" variant="default" disabled={busy} onClick={() => run(() => hangar.request.removeAgent({ id: entry.id }))}>Remove</Button>
            </Group>
          </Paper>
        );
      })}
      {error && <Text c="red" size="sm">{error}</Text>}
    </Stack>
  );
}

function Registry({ hangar }: { hangar: HangarClient }) {
  const registry = useChannel(hangar.state.registry);
  const agents = useChannel(hangar.state.agents);
  const host = useChannel(hangar.state.host);
  const { run, busy, error } = useAction();

  const added = new Set(Object.values(agents ?? {}).flatMap(entry => entry.kind === 'acp-registry' ? [entry.registryId] : []));
  const status = host?.registry;

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Title order={4}>ACP registry</Title>
        <Button
          size="xs" variant="default" leftSection={<IconRefresh size={14} />}
          loading={status?.status === 'refreshing'} disabled={busy}
          onClick={() => run(() => hangar.request.refreshRegistry())}
        >
          Refresh
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        {registry?.fetchedAt ? `Fetched ${new Date(registry.fetchedAt).toLocaleString()}` : 'Not fetched yet'}
      </Text>
      {status?.status === 'error' && <Text c="red" size="sm">{status.error}</Text>}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {Object.values(registry?.agents ?? {}).sort((a, b) => a.name.localeCompare(b.name)).map(agent => {
          const via = runsAs(agent);
          return (
            <Card key={agent.id} withBorder padding="sm">
              <Group gap="xs" wrap="nowrap">
                <Avatar src={agent.icon} size="sm" radius="sm">{agent.name[0]}</Avatar>
                <Text fw={500} truncate>{agent.name}</Text>
                <Text size="xs" c="dimmed" ml="auto">{agent.version}</Text>
              </Group>
              <Text size="sm" mt="xs" lineClamp={3} style={{ flex: 1 }}>{agent.description}</Text>
              <Group justify="space-between" mt="sm">
                <Badge variant="light" color={via ? 'gray' : 'orange'}>{via ?? 'binary only'}</Badge>
                <Button
                  size="xs"
                  disabled={busy || added.has(agent.id) || !via}
                  onClick={() => run(() => hangar.request.setAgent({
                    entry: { kind: 'acp-registry', id: agent.id, registryId: agent.id, version: 'latest' },
                  }))}
                >
                  {added.has(agent.id) ? 'Added' : 'Add'}
                </Button>
              </Group>
            </Card>
          );
        })}
      </SimpleGrid>
      {error && <Text c="red" size="sm">{error}</Text>}
    </Stack>
  );
}

export default function Agents() {
  const hangar = useHangarClient();
  return (
    <ScreenLayout title="Agents">
      <Stack gap="lg" maw={1100}>
        <StaleBanner hangar={hangar} />
        <Configured hangar={hangar} />
        <Registry hangar={hangar} />
      </Stack>
    </ScreenLayout>
  );
}
