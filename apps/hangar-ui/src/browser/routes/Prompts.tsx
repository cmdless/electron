import { createContext, useContext, useState } from 'react';
import {
  Anchor, Badge, Button, Code, Group, MultiSelect, NumberInput, Paper, Select, Stack, Switch, Text, TextInput,
} from '@mantine/core';
import type {
  ChatInputAnswer, ChatInputAnswerValue, ChatInputQuestion, InputRequestResponsePart, StringOrMarkdown, ToolCallState,
} from '@microsoft/agent-host-protocol';
import { completeInput, confirmToolCall } from '../ahp';
import type { Ahp } from '../ahp';

// what a part needs to answer the agent: the connection, and the chat and
// turn it's in
export type TurnContext = { ahp: Ahp; chat: string; turnId: string };
export const TurnContext = createContext<TurnContext | undefined>(undefined);

const textOf = (value: StringOrMarkdown | undefined) => typeof value === 'string' ? value : value?.markdown;

// a tool call, and when it's waiting on a person, what it wants to do and
// the choices for it - the agent's own options when it offered some, which
// is how an "always allow" reaches the agent that remembers it
export function ToolCallPart({ call }: { call: ToolCallState }) {
  const turn = useContext(TurnContext);
  const [answered, setAnswered] = useState(false);
  // the protocol's statuses are const enums, so they're matched by value
  const status = call.status as string;

  if (status !== 'pending-confirmation' || !turn) {
    return (
      <Group gap="xs" wrap="nowrap">
        <Badge variant="light" radius="sm" color={status === 'cancelled' ? 'gray' : undefined}>{call.displayName}</Badge>
        {call.intention && <Text size="sm" c="dimmed" truncate>{call.intention}</Text>}
        <Text size="xs" c="dimmed">{status}</Text>
      </Group>
    );
  }

  const pending = call as Extract<ToolCallState, { options?: unknown }> & { confirmationTitle?: StringOrMarkdown };
  const input = typeof pending.toolInput === 'string' ? pending.toolInput : undefined;
  const options = pending.options ?? [];
  const answer = (approved: boolean, optionId?: string) => {
    setAnswered(true);
    confirmToolCall(turn.ahp, turn.chat, turn.turnId, call.toolCallId, approved, optionId);
  };

  return (
    <Paper withBorder p="sm" radius="md" style={{ borderColor: 'var(--mantine-color-orange-filled)' }}>
      <Stack gap="xs">
        <Group gap="xs">
          <Badge variant="light" color="orange" radius="sm">{call.displayName}</Badge>
          <Text size="sm" fw={500}>{textOf(pending.confirmationTitle) ?? 'Allow this?'}</Text>
        </Group>
        <Text size="sm">{textOf(pending.invocationMessage)}</Text>
        {input && <Code block style={{ maxHeight: 240, overflow: 'auto' }}>{input}</Code>}
        <Group gap="xs">
          {options.length > 0
            ? options.map(option => (
              <Button
                key={option.id} size="xs" disabled={answered}
                variant={(option.kind as string) === 'approve' ? 'filled' : 'default'}
                onClick={() => answer((option.kind as string) === 'approve', option.id)}
              >
                {option.label}
              </Button>
            ))
            : (
              <>
                <Button size="xs" disabled={answered} onClick={() => answer(true)}>Allow</Button>
                <Button size="xs" variant="default" disabled={answered} onClick={() => answer(false)}>Deny</Button>
              </>
            )}
        </Group>
      </Stack>
    </Paper>
  );
}

// one question's input, for the answer it's given
function Question({ question, value, onChange }: {
  question: ChatInputQuestion;
  value: ChatInputAnswerValue | undefined;
  onChange: (value: ChatInputAnswerValue | undefined) => void;
}) {
  const label = question.title ?? question.message;
  const description = question.title ? question.message : undefined;
  const common = { label, description, required: question.required, size: 'xs' as const };
  switch (question.kind as string) {
    case 'text':
      return <TextInput {...common} value={(value?.value as string) ?? ''} onChange={event => onChange({ kind: 'text', value: event.currentTarget.value } as ChatInputAnswerValue)} />;
    case 'number':
    case 'integer':
      return (
        <NumberInput
          {...common} allowDecimal={(question.kind as string) === 'number'}
          value={(value?.value as number) ?? ''}
          onChange={next => onChange(typeof next === 'number' ? { kind: 'number', value: next } as ChatInputAnswerValue : undefined)}
        />
      );
    case 'boolean':
      return <Switch label={label} description={description} checked={(value?.value as boolean) ?? false} onChange={event => onChange({ kind: 'boolean', value: event.currentTarget.checked } as ChatInputAnswerValue)} />;
    case 'single-select': {
      const { options } = question as Extract<ChatInputQuestion, { options: unknown }>;
      return (
        <Select
          {...common} data={options.map(option => ({ value: option.id, label: option.label }))}
          value={(value?.value as string) ?? null}
          onChange={next => onChange(next ? { kind: 'selected', value: next } as ChatInputAnswerValue : undefined)}
        />
      );
    }
    case 'multi-select': {
      const { options } = question as Extract<ChatInputQuestion, { options: unknown }>;
      return (
        <MultiSelect
          {...common} data={options.map(option => ({ value: option.id, label: option.label }))}
          value={(value?.value as string[]) ?? []}
          onChange={next => onChange({ kind: 'selected-many', value: next } as ChatInputAnswerValue)}
        />
      );
    }
    default:
      return <Text size="sm">{label}</Text>;
  }
}

// the starting answer for a question, from what's been drafted or its default
function initialValue(question: ChatInputQuestion, drafted: ChatInputAnswer | undefined): ChatInputAnswerValue | undefined {
  if (drafted && 'value' in drafted) return drafted.value;
  const fallback = (question as { defaultValue?: unknown }).defaultValue;
  if (fallback === undefined) return undefined;
  const kind = typeof fallback === 'boolean' ? 'boolean' : typeof fallback === 'number' ? 'number' : 'text';
  return { kind, value: fallback } as ChatInputAnswerValue;
}

const answeredAs: Record<string, string> = { accept: 'answered', decline: 'declined', cancel: 'cancelled' };

// a question from the agent: a form for its questions, then accept or
// decline - or a page to open, which the host completes itself when the page's
// own flow finishes, so it can only be cancelled from here. Once answered it
// says how.
export function InputRequestPart({ part }: { part: InputRequestResponsePart }) {
  const turn = useContext(TurnContext);
  const { request } = part;
  const questions = request.questions ?? [];
  const [values, setValues] = useState<Record<string, ChatInputAnswerValue | undefined>>(() =>
    Object.fromEntries(questions.map(question => [question.id, initialValue(question, request.answers?.[question.id])])));
  const [answered, setAnswered] = useState(false);

  if (part.response || !turn) {
    return (
      <Text size="sm" c="dimmed">
        {request.message ?? 'The agent asked a question'} - {part.response ? answeredAs[part.response as string] : 'not answered'}
      </Text>
    );
  }

  const missing = questions.some(question => question.required && values[question.id] === undefined);
  const complete = (response: 'accept' | 'decline' | 'cancel') => {
    setAnswered(true);
    const answers = response !== 'accept' ? undefined : Object.fromEntries(questions.map(question => {
      const value = values[question.id];
      return [question.id, value === undefined ? { state: 'skipped' } : { state: 'submitted', value }];
    })) as Record<string, ChatInputAnswer>;
    completeInput(turn.ahp, turn.chat, request.id, response, answers);
  };

  return (
    <Paper withBorder p="sm" radius="md" style={{ borderColor: 'var(--mantine-color-orange-filled)' }}>
      <Stack gap="xs">
        {/* a page's message often carries what to enter there - a device code - so it reads larger */}
        {request.message && <Text size={request.url && questions.length === 0 ? 'lg' : 'sm'} fw={500}>{request.message}</Text>}
        {request.url && <Anchor href={request.url} target="_blank" size="sm">Open {new URL(request.url).host} here</Anchor>}
        {questions.map(question => (
          <Question
            key={question.id} question={question} value={values[question.id]}
            onChange={value => setValues(previous => ({ ...previous, [question.id]: value }))}
          />
        ))}
        {request.url && questions.length === 0
          ? <Group gap="xs"><Button size="xs" variant="default" disabled={answered} onClick={() => complete('cancel')}>Cancel</Button></Group>
          : (
            <Group gap="xs">
              <Button size="xs" disabled={answered || missing} onClick={() => complete('accept')}>Submit</Button>
              <Button size="xs" variant="default" disabled={answered} onClick={() => complete('decline')}>Decline</Button>
            </Group>
          )}
      </Stack>
    </Paper>
  );
}
