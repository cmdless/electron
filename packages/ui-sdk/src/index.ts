export interface Cmdless {
  invoke<T = unknown>(
    method: string,
    args?: unknown
  ): Promise<T>;
}