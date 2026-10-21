import { z } from 'zod';

// zod schemas are the source of truth here - types are inferred from them
// (not hand-duplicated) so the same schemas can be reused directly in an
// app schema (see runtime.ts) without drifting from what this module's own
// plain-TS consumers (e.g. ui-runtime's main/index.ts) already expect.

export const SetupOptionsSchema = z.object({
  app: z.string().optional(),
  parent: z.number().optional(),
});
export type SetupOptions = z.infer<typeof SetupOptionsSchema>;

export const SetupParamsSchema = SetupOptionsSchema;
export type SetupParams = z.infer<typeof SetupParamsSchema>;

export const ShowOptionsSchema = SetupParamsSchema.extend({
  width: z.number().optional(),
  height: z.number().optional(),
  address: z.string().optional(),
  // a URL prefix: when the window is about to navigate to a URL starting
  // with it, the navigation is cancelled, the window closes, and it resolves
  // to that URL - for an OAuth redirect, say. Such a window shows a third
  // party's pages, so it gets no preload (no window.cmdless).
  redirect: z.string().optional(),
  // the window shows a third party's pages without capturing a redirect - a
  // sign-in that finishes on its own, say - so it's treated like a redirect
  // window: no preload, a browser's user agent, popups as child windows
  external: z.boolean().optional(),
  // the window's title, kept whatever the page calls itself
  title: z.string().optional(),
});
export type ShowOptions = z.infer<typeof ShowOptionsSchema>;

export const ShowTypes = ['url', 'file'] as const;
export type ShowType = typeof ShowTypes[number];

export const ShowParamsSchema = ShowOptionsSchema.extend({
  kind: z.literal('show'),
  type: z.enum(ShowTypes),
  source: z.string(),
});
export type ShowParams = z.infer<typeof ShowParamsSchema>;

export const MessageBoxTypes = ['none', 'info', 'error', 'question', 'warning'] as const;
export type MessageBoxType = typeof MessageBoxTypes[number];

export const MessageBoxOptionsSchema = SetupParamsSchema;
export type MessageBoxOptions = z.infer<typeof MessageBoxOptionsSchema>;

export const MessageBoxParamsSchema = MessageBoxOptionsSchema.extend({
  kind: z.literal('message-box'),
  type: z.enum(MessageBoxTypes),
  message: z.string(),
});
export type MessageBoxParams = z.infer<typeof MessageBoxParamsSchema>;

export const ParamsSchema = z.discriminatedUnion('kind', [ShowParamsSchema, MessageBoxParamsSchema]);
export type Params = z.infer<typeof ParamsSchema>;
