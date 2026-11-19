import type { AdaptiveCard, CardEvent } from './types.js';

// An agent's two kinds of question - elicitation (MCP's, and ACP's) and a
// permission request (ACP's) - as Adaptive Cards, and what a card ends with
// as their answers. Closing the card is cancelling, in both.

// MCP and ACP elicitation, form mode: a message, and the flat schema of what
// to ask for
export type ElicitationRequest = { message: string; requestedSchema: Record<string, unknown> };

export type ElicitationResult =
  | { action: 'accept'; content: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' };

// what the form in an elicitation card is called among the card's inputs
const CONTENT = 'content';

type Schema = Record<string, unknown>;

// the requested schema as react-jsonschema-form wants it, with the uiSchema
// that goes with it: legacy enumNames are labels it reads from the uiSchema,
// and a multi-select's items are unique (or it draws a list to add to)
function formSchema(requested: Schema) {
  const properties: Record<string, Schema> = {};
  const uiSchema: Record<string, Schema> = {};
  for (const [name, field] of Object.entries((requested.properties ?? {}) as Record<string, Schema>)) {
    const { enumNames, ...rest } = field;
    properties[name] = rest.type === 'array' ? { ...rest, uniqueItems: true } : rest;
    if (Array.isArray(enumNames)) uiSchema[name] = { 'ui:enumNames': enumNames };
  }
  return { schema: { ...requested, type: 'object', properties }, uiSchema };
}

// a card asking what an elicitation asks: its message, its schema as a form,
// and Accept (once the form is valid) or Decline (whatever's in it)
export function elicitationCard({ message, requestedSchema }: ElicitationRequest): AdaptiveCard {
  const { schema, uiSchema } = formSchema(requestedSchema);
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: message, wrap: true },
      { type: 'Input.JsonSchema', id: CONTENT, schema, uiSchema },
    ],
    actions: [
      { type: 'Action.Submit', title: 'Accept', style: 'positive', data: { action: 'accept' } },
      { type: 'Action.Submit', title: 'Decline', associatedInputs: 'none', data: { action: 'decline' } },
    ],
  };
}

// what an elicitation card ended with, as the elicitation's answer
export function elicitationResult(submitted: CardEvent | undefined): ElicitationResult {
  const action = (submitted?.action.data as { action?: string } | undefined)?.action;
  if (action === 'accept') return { action, content: (submitted!.inputs[CONTENT] ?? {}) as Record<string, unknown> };
  if (action === 'decline') return { action };
  return { action: 'cancel' };
}

// ACP's permission request: what's being asked, and the choices - each with
// a kind (allow_once, allow_always, reject_once, reject_always, ...)
export type PermissionRequest = {
  title: string;
  description?: string;
  options: { optionId: string; name: string; kind: string }[];
};

export type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

// a card asking a permission request: its title and description, and a
// button per option - allowing ones first in line, rejecting ones in red
export function permissionCard({ title, description, options }: PermissionRequest): AdaptiveCard {
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
      ...(description ? [{ type: 'TextBlock', text: description, wrap: true, isSubtle: true }] : []),
    ],
    actions: options.map(({ optionId, name, kind }) => ({
      type: 'Action.Submit',
      title: name,
      style: kind.startsWith('allow') ? 'positive' : kind.startsWith('reject') ? 'destructive' : 'default',
      data: { optionId },
    })),
  };
}

// what a permission card ended with, as the request's outcome
export function permissionResult(submitted: CardEvent | undefined): PermissionOutcome {
  const optionId = (submitted?.action.data as { optionId?: string } | undefined)?.optionId;
  return optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId };
}
