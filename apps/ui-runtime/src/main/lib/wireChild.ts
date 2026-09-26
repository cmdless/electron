import type { BinMessage, BinCleanup } from '@cmdless/ui-sdk/node';
import { binOutput } from '@cmdless/ui-sdk/node';

export type ChildLike = {
  on(event: 'message', listener: (message: BinMessage) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
};

export function wireChild(
  child: ChildLike,
  write: (text: string) => void,
  rm: (path: string) => void,
) {
  let cleanup: BinCleanup | undefined;
  child.on('message', (message: BinMessage) => {
    if (message.type === 'cleanup') {
      cleanup = message;
      return;
    }
    if (message.value !== null)
      write(binOutput(message.value));
  });
  child.on('exit', code => {
    if (cleanup)
      rm(cleanup.userData);
    process.exitCode = code ?? 1;
  });
}
