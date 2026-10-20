import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon, Anchor, Badge, Box, Button, Center, Group, Loader, NavLink, Paper, Popover, ScrollArea, Select, Spoiler, Stack, Text,
  Textarea, TextInput,
} from '@mantine/core';
import { IconArrowUp, IconPlayerStopFilled, IconPlus, IconSearch } from '@tabler/icons-react';
import Markdown from 'react-markdown';
import type {
  ActiveTurn, AgentInfo, ChatState, ConfigPropertySchema, ModelSelection, ResponsePart, SessionState, Turn, URI,
} from '@microsoft/agent-host-protocol';
import { ScreenLayout } from '../layout';
import { cancelTurn, createSession, pushTrust, sendMessage, setSessionConfig, useAhp, useChat, useSession } from '../ahp';
import { useHangarClient } from '../hangar';
import { useChannel } from '../useHangar';
import type { Ahp } from '../ahp';

const AGENT_KEY = 'hangar-ui:agent';
const modelKey = (provider: string) => `hangar-ui:model:${provider}`;
const folderKey = (provider: string) => `hangar-ui:folder:${provider}`;

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

function readModel(provider: string): ModelSelection | undefined {
  try {
    return JSON.parse(localStorage.getItem(modelKey(provider)) ?? 'null') ?? undefined;
  } catch {
    return undefined;
  }
}

// the properties of a schema that are a pick from a list, as dropdowns
function enumsOf(properties: Record<string, ConfigPropertySchema> = {}) {
  return Object.entries(properties).filter(([, property]) => property.enum && !property.readOnly).map(([key, property]) => ({
    key,
    property,
    data: property.enum!.map((value, index) => ({ value: String(value), label: property.enumLabels?.[index] ?? String(value) })),
  }));
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

// the message box and the dropdowns under it: the model and its options,
// which go with each message, and the session's own settings, which change
// the session as they're picked
function Composer({ ahp, agent, session, sessionUri, chatUri, chat }: {
  ahp: Ahp;
  agent: AgentInfo | undefined;
  session: SessionState;
  sessionUri: URI;
  chatUri: URI;
  chat: ChatState;
}) {
  const provider = agent?.provider ?? '';
  const [text, setText] = useState('');
  const [model, setModel] = useState<ModelSelection | undefined>(() => readModel(provider));
  useEffect(() => { if (model) localStorage.setItem(modelKey(provider), JSON.stringify(model)); }, [provider, model]);

  const models = agent?.models ?? [];
  // the remembered model, if the agent still has it
  const current = models.find(each => each.id === model?.id);
  const modelOptions = enumsOf(current?.configSchema?.properties);
  const sessionOptions = enumsOf(session.config?.schema.properties as Record<string, ConfigPropertySchema> | undefined);
  const active = chat.activeTurn;

  const send = () => {
    if (!text.trim() || active) return;
    sendMessage(ahp, chatUri, text, current ? { id: current.id, ...(model?.config ? { config: model.config } : {}) } : undefined);
    setText('');
  };

  return (
    <Paper withBorder radius="lg" p="xs">
      <Textarea
        variant="unstyled" autosize minRows={2} maxRows={12} px="xs" autoFocus
        placeholder={`Message ${agent?.displayName ?? 'the agent'}`}
        value={text} onChange={event => setText(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
          }
        }}
      />
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Group gap="xs">
          {models.length > 0 && (
            <Select
              size="xs" w={200} placeholder="Default model" clearable searchable
              data={models.map(each => ({ value: each.id, label: each.name }))}
              value={current?.id ?? null}
              onChange={id => setModel(id ? { id } : undefined)}
            />
          )}
          {modelOptions.map(({ key, property, data }) => (
            <Select
              key={`model:${key}`} size="xs" w={150} placeholder={property.title} data={data} clearable
              value={model?.config?.[key] !== undefined ? String(model.config[key]) : property.default !== undefined ? String(property.default) : null}
              onChange={value => setModel(previous => previous && {
                ...previous,
                config: { ...previous.config, [key]: property.enum!.find(each => String(each) === value) ?? null },
              })}
            />
          ))}
          {sessionOptions.map(({ key, property, data }) => (
            <Select
              key={`session:${key}`} size="xs" w={150} placeholder={property.title} data={data} allowDeselect={false}
              value={session.config?.values[key] !== undefined ? String(session.config.values[key]) : null}
              onChange={value => setSessionConfig(ahp, sessionUri, {
                [key]: property.enum!.find(each => String(each) === value),
              })}
            />
          ))}
        </Group>
        {active
          ? <ActionIcon radius="xl" size="lg" color="red" aria-label="Stop" onClick={() => cancelTurn(ahp, chatUri, active.id)}><IconPlayerStopFilled size={16} /></ActionIcon>
          : <ActionIcon radius="xl" size="lg" aria-label="Send" disabled={!text.trim()} onClick={send}><IconArrowUp size={18} /></ActionIcon>}
      </Group>
    </Paper>
  );
}

// a session's chat: the composer alone in the middle until the first message,
// then the conversation with the composer pinned under it
function Conversation({ ahp, agent, session, sessionUri, uri }: { ahp: Ahp; agent: AgentInfo | undefined; session: SessionState; sessionUri: URI; uri: URI }) {
  const chat = useChat(ahp.client, uri);
  if (!chat) return <Center h="60vh"><Loader size="sm" /></Center>;
  const composer = <Composer ahp={ahp} agent={agent} session={session} sessionUri={sessionUri} chatUri={uri} chat={chat} />;

  if (chat.turns.length === 0 && !chat.activeTurn)
    return (
      <Center h="70vh">
        <Stack w="100%" maw={760} gap="md">
          <Text size="xl" fw={600} ta="center">What should {agent?.displayName ?? 'the agent'} do?</Text>
          {composer}
        </Stack>
      </Center>
    );

  return (
    <Stack maw={860} mx="auto" gap="xl">
      {chat.turns.map(turn => <TurnView key={turn.id} turn={turn} />)}
      {chat.activeTurn && <TurnView turn={chat.activeTurn} />}
      <Box pos="sticky" bottom={0} pb="md" bg="var(--mantine-color-body)">{composer}</Box>
    </Stack>
  );
}

// whether hangar trusts a folder: it, or a folder it's inside, is on the list
const isTrusted = (folders: string[], folder: string) =>
  folders.some(each => folder === each || folder.startsWith(each.endsWith('/') ? each : `${each}/`));

// starts a session in a folder, the last one used with this agent by default.
// A folder hangar doesn't trust yet is trusted first, on the person's say-so,
// since ahpd won't start an agent anywhere nobody vouched for.
function NewSession({ ahp, provider, onCreated }: { ahp: Ahp; provider: string; onCreated: (uri: URI) => void }) {
  const hangar = useHangarClient();
  const trust = useChannel(hangar.state.trust);
  const [opened, setOpened] = useState(false);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [imported, setImported] = useState<string>();

  const where = folder.trim().replace(/(.)\/+$/, '$1');
  const invalid = where !== '' && !where.startsWith('/');
  const untrusted = where !== '' && !invalid && !!trust && !isTrusted(trust.folders, where);

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    action().catch(reason => setError(String(reason?.message ?? reason))).finally(() => setBusy(false));
  };

  const create = () => run(async () => {
    if (invalid) throw new Error('The folder needs to be an absolute path.');
    if (untrusted) {
      await hangar.request.trustFolder({ path: where });
      // said to ahpd now rather than when hangar's list comes back around, so
      // the session below is created with it
      pushTrust(ahp, [...trust!.folders, where]);
    }
    const uri = await createSession(ahp, provider, where || undefined);
    if (where) localStorage.setItem(folderKey(provider), where);
    else localStorage.removeItem(folderKey(provider));
    setOpened(false);
    onCreated(uri);
  });

  const importCodex = () => run(async () => {
    const { added } = await hangar.request.importCodexTrust();
    setImported(added.length === 0 ? 'Nothing new to import.' : `Imported ${added.length} folder${added.length === 1 ? '' : 's'}.`);
  });

  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-start" width={340} trapFocus>
      <Popover.Target>
        <Button
          size="xs" variant="light" leftSection={<IconPlus size={14} />} fullWidth
          onClick={() => {
            setFolder(localStorage.getItem(folderKey(provider)) ?? '');
            setError(undefined);
            setImported(undefined);
            setOpened(value => !value);
          }}
        >
          New session
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <TextInput
            size="xs" label="Folder" placeholder="The agent's default" data-autofocus
            value={folder} onChange={event => setFolder(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === 'Enter') create(); }}
            error={invalid ? 'Use an absolute path' : undefined}
          />
          {untrusted && (
            <Text size="xs" c="dimmed">
              Hangar doesn't trust this folder yet. Trusting it lets agents load its project settings, hooks and MCP servers.
            </Text>
          )}
          {error && <Text c="red" size="xs">{error}</Text>}
          <Button size="xs" loading={busy} disabled={invalid} onClick={create}>
            {untrusted ? 'Trust folder and create' : 'Create'}
          </Button>
          <Group justify="space-between">
            <Anchor component="button" size="xs" c="dimmed" disabled={busy} onClick={importCodex}>Import Codex's trusted folders</Anchor>
            {imported && <Text size="xs" c="dimmed">{imported}</Text>}
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export default function Chat() {
  const { ahp, error } = useAhp();
  const [agent, setAgent] = useState<string | null>(() => localStorage.getItem(AGENT_KEY));
  const [selected, setSelected] = useState<URI>();
  const [filter, setFilter] = useState('');

  const agents = ahp?.root.agents ?? [];
  // the remembered agent, if this host still has it, or else its first
  const current = agents.some(each => each.provider === agent) ? agent : agents[0]?.provider ?? null;
  const agentInfo = agents.find(each => each.provider === current);
  useEffect(() => { if (current) localStorage.setItem(AGENT_KEY, current); }, [current]);

  const sessions = useMemo(() => Object.values(ahp?.sessions ?? {})
    .filter(session => session.provider === current)
    .filter(session => !filter || session.title.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)), [ahp?.sessions, current, filter]);

  // subscribed by the name it was picked or made under, which for a session
  // just created may be before the list has it
  const session = useSession(ahp?.client, selected);
  const chat = session && chatOf(session);
  const title = (selected && ahp?.sessions[selected]?.title) || session?.title || 'Chat';

  const headerRight = (
    <Select
      size="xs" w={220} placeholder="Agent" allowDeselect={false}
      data={agents.map(each => ({ value: each.provider, label: each.displayName }))}
      value={current} onChange={value => { setAgent(value); setSelected(undefined); }}
    />
  );

  const navbar = (
    <>
      <Stack p="xs" gap="xs">
        {ahp && current && <NewSession ahp={ahp} provider={current} onCreated={setSelected} />}
        <TextInput size="xs" placeholder="Filter sessions" leftSection={<IconSearch size={14} />} value={filter} onChange={event => setFilter(event.currentTarget.value)} />
      </Stack>
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
    <ScreenLayout title={title} headerRight={headerRight} navbar={navbar}>
      {error && <Text c="red">{error}</Text>}
      {!error && !ahp && <Center h="60vh"><Loader size="sm" /></Center>}
      {ahp && !selected && <Center h="60vh"><Text c="dimmed">Pick a session, or start a new one.</Text></Center>}
      {ahp && selected && !session && <Center h="60vh"><Loader size="sm" /></Center>}
      {ahp && session && !chat && <Center h="60vh"><Loader size="sm" /></Center>}
      {ahp && session && chat && <Conversation key={chat} ahp={ahp} agent={agentInfo} session={session} sessionUri={selected!} uri={chat} />}
    </ScreenLayout>
  );
}
