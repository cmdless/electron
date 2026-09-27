import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShowCommand } from "@cmdless/ui-sdk/node";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(__dirname, '../../dist/index.html');

export const agentPickerCommand = createShowCommand({
  params: () => ({
    type: 'file',
    source,
  }),
});