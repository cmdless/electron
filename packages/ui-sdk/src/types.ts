export type SetupOptions = {
  app?: string;
  parent?: string;
};

export type SetupParams = SetupOptions & {};

export type ShowOptions = SetupParams & {
  width?: number;
  height?: number;
  address?: string;
};

export const ShowTypes = ['url', 'file'] as const;
export type ShowType = typeof ShowTypes[number];
export type ShowParams = ShowOptions & {
  kind: 'show';
  type: ShowType;
  source: string;
};

export const MessageBoxTypes = ['none', 'info', 'error', 'question', 'warning'] as const;
export type MessageBoxType = typeof MessageBoxTypes[number];
export type MessageBoxOptions = SetupParams & {};

export type MessageBoxParams = MessageBoxOptions & {
  kind: 'message-box';
  type: MessageBoxType;
  message: string;
};

export type Params =
  | ShowParams
  | MessageBoxParams;