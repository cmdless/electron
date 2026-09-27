#!/usr/bin/env node

import { agentPickerCommand } from './command.js';

const result = await agentPickerCommand();
process.stdout.write(result);