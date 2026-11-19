// what a window shows: a URL, or a file
export const ShowTypes = ['url', 'file'] as const;
export type ShowType = typeof ShowTypes[number];

// the kinds of message box a dialog can be
export const MessageBoxTypes = ['none', 'info', 'error', 'question', 'warning'] as const;
export type MessageBoxType = typeof MessageBoxTypes[number];

// an Adaptive Card (adaptivecards.io), already expanded: plain card JSON
// with no ${} bindings left in it
export type AdaptiveCard = { type: 'AdaptiveCard'; [key: string]: unknown };

// an action chosen on a card - an Action.Submit, which ends the card with
// it, or an Action.Execute, which is reported while the card stays up: the
// action as it was written (its type, id, title, verb and data), and every
// input's value by its id
export type CardEvent = {
  action: { type: string; id?: string; title?: string; verb?: string; data?: unknown;[key: string]: unknown };
  inputs: Record<string, unknown>;
};

// what a card window shows: the card, and optionally how it's styled (an
// Adaptive Cards host config - left out, one that follows the system's
// light or dark appearance)
export type CardView = { card: AdaptiveCard; hostConfig?: object };

// what a form window shows: a JSON Schema, with react-jsonschema-form's
// uiSchema and starting formData, and what its submit button says
export type FormView = { schema: object; uiSchema?: object; formData?: unknown; submitText?: string };
