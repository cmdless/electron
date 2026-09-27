import type { BinMessage } from '@cmdless/ui-sdk/node';
import { binOutput } from '@cmdless/ui-sdk/node';

export function wireChild(
  write: (text: string) => void,
  rm: (path: string) => void,
) {
  let cleanup: { userData: string } | undefined;

  return {
    onMessage: (message: BinMessage) => {
      if (message.type === 'cleanup') {
        cleanup = message;
        return;
      }
      if (message.value !== null)
        write(binOutput(message.value));
    },
    onExit: (code: number | null) => {
      if (cleanup)
        rm(cleanup.userData);
      process.exitCode = code ?? 1;
    },
  };
}
