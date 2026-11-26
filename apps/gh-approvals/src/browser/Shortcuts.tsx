import { useEffect, useState } from 'react';
import { Button, CopyButton, Group, Select, Stack, Text, Textarea } from '@mantine/core';
import { shortcutsProtocol } from '../shared/protocols';
import { fileName, PLATFORMS, shortcut, SOURCES } from '../shared/shortcuts';
import type { Platform, Source } from '../shared/shortcuts';
import { useBackend, useChannel } from './backend';

// a script that starts the tray as this one was started, for the platform
// and source picked - this platform's, from GitHub, to begin with
export default function Shortcuts() {
  const { client, error } = useBackend(shortcutsProtocol);
  const settings = useChannel(client?.state.settings);
  const [platform, setPlatform] = useState<Platform>();
  const [source, setSource] = useState<Source>('github');

  useEffect(() => {
    if (settings && !platform) setPlatform(settings.platform);
  }, [settings, platform]);

  if (!settings || !platform) return <Text p="md" c="dimmed">{error ?? 'Connecting…'}</Text>;
  const script = shortcut(settings, platform, source);

  return (
    <Stack p="md" h="100vh">
      <Group align="end">
        <Select label="Platform" data={PLATFORMS} value={platform} allowDeselect={false}
          onChange={value => value && setPlatform(value as Platform)} />
        <Select label="From" data={SOURCES} value={source} allowDeselect={false}
          onChange={value => value && setSource(value as Source)} />
        <CopyButton value={script}>
          {({ copied, copy }) => (
            <Button ml="auto" color={copied ? 'teal' : undefined} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
          )}
        </CopyButton>
      </Group>
      <Text size="sm" c="dimmed">Save it as <b>{fileName(settings, platform)}</b>.</Text>
      <Textarea readOnly value={script} style={{ flex: 1 }}
        styles={{ wrapper: { height: '100%' }, input: { height: '100%', whiteSpace: 'pre', overflowX: 'auto', fontFamily: 'var(--mantine-font-family-monospace)' } }} />
    </Stack>
  );
}
