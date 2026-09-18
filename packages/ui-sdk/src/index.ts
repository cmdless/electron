export type SetupOptions = {
  address?: string;
};

export type SetupParams = SetupOptions & {
  token?: string;
};

export type ShowOptions = SetupParams & {
  width: number;
  height: number;
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
export type MessageBoxOptions = SetupParams & {
  type: MessageBoxType;
};

export type MessageBoxParams = MessageBoxOptions & {
  kind: 'message-box';
  message: string;
};

export type Params =
  | ShowParams
  | MessageBoxParams;

export interface Cmdless {
  invoke<T = unknown>(
    method: string,
    args?: unknown
  ): Promise<T>;
  resolve<T = unknown>(
    value: T,
    exitCode?: number
  ): void;
}