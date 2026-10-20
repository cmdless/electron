import { useEffect, useMemo, useState } from 'react';
import {
  Badge, Box, Center, Group, Loader, NavLink, Paper, ScrollArea, Select, Spoiler, Stack, Text, TextInput,
} from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import Markdown from 'react-markdown';
import type { ActiveTurn, ResponsePart, SessionState, Turn } from '@microsoft/agent-host-protocol';
import type { AhpClient } from '@microsoft/agent-host-protocol/client';
import { ScreenLayout } from '../layout';
import { useAhp, useChat, useSession } from '../ahp';

const AGENT_KEY = 'hangar-ui:agent';

// SessionStatus is a bit field: InProgress is 1 << 3, InputNeeded adds 1 << 4
const statusOf = (status: number) =>
  status & (1 << 4) ? { label: 'needs input', color: 'orange' }
    : status & (1 << 3) ? { label: 'working', color: 'blue' }
      : status & (1 << 1) ? { label: 'error', color: 'red' }
        : undefined;

function ago(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

// the conversation a session opens on: its default chat, or its first
function chatOf(session: SessionState) {
  return session.defaultChat ?? session.chats?.[0]?.resource;
}

function Part({ part }: { part: ResponsePart }) {
  // the protocol's kinds are const enums, so they're matched by value
  switch (part.kind as string) {
    case 'markdown':
      return <Box className="markdown"><Markdown>{(part as { content: string }).content}</Markdown></Box>;
    case 'reasoning':
      return (
        <Spoiler maxHeight={0} showLabel="Show reasoning" hideLabel="Hide reasoning">
          <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{(part as { content: string }).content}</Text>
        </Spoiler>
      );
    case 'toolCall': {
      const call = (part as { toolCall: { displayName: string; intention?: string; status: string } }).toolCall;
      return (
        <Group gap="xs">
          <Badge variant="light" radius="sm">{call.displayName}</Badge>
          {call.intention && <Text size="sm" c="dimmed" truncate>{call.intention}</Text>}
          <Text size="xs" c="dimmed">{call.status}</Text>
        </Group>
      );
    }
    case 'error':
      return <Text c="red" size="sm">{(part as { error: { message?: string } }).error.message ?? 'Something went wrong'}</Text>;
    default:
      return null;
  }
}

function TurnView({ turn }: { turn: Turn | ActiveTurn }) {
  return (
    <Stack gap="xs">
      {turn.message.text && (
        <Group justify="flex-end">
          <Paper bg="var(--mantine-color-default-hover)" px="md" py="xs" radius="lg" maw="80%">
            <Text style={{ whiteSpace: 'pre-wrap' }}>{turn.message.text}</Text>
          </Paper>
        </Group>
      )}
      {turn.responseParts.map((part, index) => <Part key={'id' in part ? String(part.id) : index} part={part} />)}
    </Stack>
  );
}

function Conversation({ client, uri }: { client: AhpClient; uri: string }) {
  const chat = useChat(client, uri);
  if (!chat) return <Center h="100%"><Loader size="sm" /></Center>;
  if (chat.turns.length === 0 && !chat.activeTurn)
    return <Center h="100%"><Text c="dimmed">No messages yet.</Text></Center>;
  return (
    <Stack gap="xl" maw={860} mx="auto" pb="xl">
      {chat.turns.map(turn => <TurnView key={turn.id} turn={turn} />)}
      {chat.activeTurn && <TurnView turn={chat.activeTurn} />}
    </Stack>
  );
}

export default function Chat() {
  const { ahp, error } = useAhp();
  const [agent, setAgent] = useState<string | null>(() => localStorage.getItem(AGENT_KEY));
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState('');

  const agents = ahp?.root.agents ?? [];
  // the remembered agent, if this host still has it, or else its first
  const current = agents.some(each => each.provider === agent) ? agent : agents[0]?.provider ?? null;
  useEffect(() => { if (current) localStorage.setItem(AGENT_KEY, current); }, [current]);

  const sessions = useMemo(() => Object.values(ahp?.sessions ?? {})
    .filter(session => session.provider === current)
    .filter(session => !filter || session.title.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)), [ahp?.sessions, current, filter]);

  const open = selected ? ahp?.sessions[selected] : undefined;
  const session = useSession(ahp?.client, open?.resource);
  const chat = session && chatOf(session);

  const headerRight = (
    <Select
      size="xs" w={220} placeholder="Agent" allowDeselect={false}
      data={agents.map(each => ({ value: each.provider, label: each.displayName }))}
      value={current} onChange={value => { setAgent(value); setSelected(undefined); }}
    />
  );

  const navbar = (
    <>
      <Box p="xs">
        <TextInput size="xs" placeholder="Filter sessions" leftSection={<IconSearch size={14} />} value={filter} onChange={event => setFilter(event.currentTarget.value)} />
      </Box>
      <ScrollArea style={{ flex: 1 }}>
        {sessions.map(session => {
          const status = statusOf(session.status as number);
          return (
            <NavLink
              key={session.resource}
              active={session.resource === selected}
              onClick={() => setSelected(session.resource)}
              label={<Text size="sm" truncate>{session.title || 'Untitled'}</Text>}
              description={ago(session.modifiedAt)}
              rightSection={status && <Badge size="xs" variant="light" color={status.color}>{status.label}</Badge>}
            />
          );
        })}
        {ahp && sessions.length === 0 && <Text size="sm" c="dimmed" p="md">No sessions{filter ? ' match' : ' yet'}.</Text>}
      </ScrollArea>
    </>
  );

  return (
    <ScreenLayout title={open?.title || 'Chat'} headerRight={headerRight} navbar={navbar}>
      {error && <Text c="red">{error}</Text>}
      {!error && !ahp && <Center h="60vh"><Loader size="sm" /></Center>}
      {ahp && !open && <Center h="60vh"><Text c="dimmed">Pick a session.</Text></Center>}
      {ahp && open && !session && <Center h="60vh"><Loader size="sm" /></Center>}
      {ahp && session && !chat && <Center h="60vh"><Text c="dimmed">This session has no chat to show.</Text></Center>}
      {ahp && chat && <Conversation key={chat} client={ahp.client} uri={chat} />}
    </ScreenLayout>
  );
}
