#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { Argument, Command } from 'commander';
import { types } from '@cmdless/ui-sdk';
import type { ElicitationRequest, PermissionRequest } from '@cmdless/ui-sdk';
import { runAsPackage, UIHost } from '@cmdless/ui-sdk/node';
import type { CreateHostOptions, WindowParams } from '@cmdless/ui-sdk/node';

// how a one-shot command prints the value it ended with
const binOutput = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);

type HostTarget = { app?: string; root?: string; timeout?: number };

// the host to use, and how the window looks (--width, --height, --title)
type WindowFlags = HostTarget & { width?: number; height?: number; title?: string };

const hostOptions = ({ app, root, timeout }: HostTarget): CreateHostOptions => ({ app, cmdlessRoot: root, timeoutMs: timeout });

const program = new Command().name('ui').enablePositionalOptions();

// shows a window on a host - this one's own, unless --app names one to join -
// and prints the value it ends with
program
  .command('window').description('Show a window, and print the value it ends with')
  .addArgument(new Argument('<type>', 'Source type to show in the window').choices(types.ShowTypes))
  .argument('<source>', 'File or URL to open in the window')
  .option('--app <name>', 'App name: the host to show it on, joined if it is already running')
  .option('--root <path>', 'cmdless root to run the host from')
  .option('--timeout <ms>', 'How long the host gets to start', Number)
  .option('--width <number>', 'Width of the window', Number)
  .option('--height <number>', 'Height of the window', Number)
  .option('--redirect <prefix>', 'End the window when it navigates to a URL starting with this, resolving to that URL')
  .option('--external', 'Show a third party\'s pages: no preload, a browser user agent, popups as child windows')
  .option('--title <title>', 'Title of the window, kept whatever the page calls itself')
  .action(async (type: types.ShowType, source: string, options: Pick<WindowParams, 'redirect' | 'external'> & WindowFlags) => {
    const { app, root, timeout, width, height, title, ...page } = options;
    const value = await UIHost.showWindow(hostOptions({ app, root, timeout }), { type, source, ...page, window: { width, height, title } });
    process.stdout.write(binOutput(value));
  });

// shows a message box on a host, and prints what was chosen
program
  .command('dialog').description('Show a message box, and print the button that was chosen')
  .addArgument(new Argument('<type>', 'Type of message').choices(types.MessageBoxTypes))
  .argument('<message>', 'Message to show')
  .option('--app <name>', 'App name: the host to show it on, joined if it is already running')
  .option('--root <path>', 'cmdless root to run the host from')
  .option('--timeout <ms>', 'How long the host gets to start', Number)
  .action(async (type: types.MessageBoxType, message: string, options: HostTarget) => {
    const value = await UIHost.showDialog(hostOptions(options), { type, message });
    process.stdout.write(binOutput(value));
  });

// a JSON file's contents
const readJson = async <T>(file: string) => JSON.parse(await readFile(file, 'utf8')) as T;


// shows an Adaptive Card on a host, and prints the Action.Submit chosen on
// it - nothing, and exit code 1, if it was closed instead
program
  .command('card').description('Show an Adaptive Card, and print the Submit action chosen on it with its inputs')
  .argument('<file>', 'Adaptive Card JSON file (already expanded: no ${} bindings)')
  .option('--host-config <file>', 'Adaptive Cards host config JSON file')
  .option('--app <name>', 'App name: the host to show it on, joined if it is already running')
  .option('--root <path>', 'cmdless root to run the host from')
  .option('--timeout <ms>', 'How long the host gets to start', Number)
  .option('--width <number>', 'Width of the window', Number)
  .option('--height <number>', 'Height of the window', Number)
  .option('--title <title>', 'Title of the window')
  .action(async (file: string, options: WindowFlags & { hostConfig?: string }) => {
    const { app, root, timeout, hostConfig, ...window } = options;
    const value = await UIHost.showCard(hostOptions({ app, root, timeout }), {
      window,
      card: await readJson(file),
      hostConfig: hostConfig ? await readJson(hostConfig) : undefined,
    });
    if (value === undefined) process.exitCode = 1;
    else process.stdout.write(binOutput(value));
  });

// shows a JSON Schema form on a host, and prints the data it was submitted
// with - nothing, and exit code 1, if it was cancelled
program
  .command('form').description('Show a JSON Schema form, and print the data it was submitted with')
  .argument('<schema>', 'JSON Schema file')
  .option('--ui-schema <file>', 'react-jsonschema-form uiSchema JSON file')
  .option('--data <file>', 'JSON file of the values to start with')
  .option('--submit-text <text>', 'What the submit button says')
  .option('--app <name>', 'App name: the host to show it on, joined if it is already running')
  .option('--root <path>', 'cmdless root to run the host from')
  .option('--timeout <ms>', 'How long the host gets to start', Number)
  .option('--width <number>', 'Width of the window', Number)
  .option('--height <number>', 'Height of the window', Number)
  .option('--title <title>', 'Title of the window')
  .action(async (schema: string, options: WindowFlags & { uiSchema?: string; data?: string; submitText?: string }) => {
    const { app, root, timeout, uiSchema, data, submitText, ...window } = options;
    const value = await UIHost.showForm(hostOptions({ app, root, timeout }), {
      window,
      submitText,
      schema: await readJson(schema),
      uiSchema: uiSchema ? await readJson(uiSchema) : undefined,
      formData: data ? await readJson(data) : undefined,
    });
    if (value === undefined) process.exitCode = 1;
    else process.stdout.write(binOutput(value));
  });

// asks an elicitation (MCP's or ACP's, form mode) as a card, and prints its
// answer: { action: accept, content } or { action: decline | cancel }
program
  .command('elicit').description('Ask an elicitation as a card, and print its result')
  .argument('<file>', 'JSON file of the request: { message, requestedSchema }')
  .option('--app <name>', 'App name: the host to show it on, joined if it is already running')
  .option('--root <path>', 'cmdless root to run the host from')
  .option('--timeout <ms>', 'How long the host gets to start', Number)
  .option('--width <number>', 'Width of the window', Number)
  .option('--height <number>', 'Height of the window', Number)
  .option('--title <title>', 'Title of the window')
  .action(async (file: string, options: WindowFlags) => {
    const { app, root, timeout, ...window } = options;
    const request = await readJson<ElicitationRequest>(file);
    process.stdout.write(binOutput(await UIHost.showElicitation(hostOptions({ app, root, timeout }), { ...request, window })));
  });

// asks a permission request (ACP's) as a card, and prints its outcome:
// { outcome: selected, optionId } or { outcome: cancelled }
program
  .command('permission').description('Ask a permission request as a card, and print its outcome')
  .argument('<file>', 'JSON file of the request: { title, description?, options: [{ optionId, name, kind }] }')
  .option('--app <name>', 'App name: the host to show it on, joined if it is already running')
  .option('--root <path>', 'cmdless root to run the host from')
  .option('--timeout <ms>', 'How long the host gets to start', Number)
  .option('--width <number>', 'Width of the window', Number)
  .option('--height <number>', 'Height of the window', Number)
  .option('--title <title>', 'Title of the window')
  .action(async (file: string, options: WindowFlags) => {
    const { app, root, timeout, ...window } = options;
    const request = await readJson<PermissionRequest>(file);
    process.stdout.write(binOutput(await UIHost.showPermission(hostOptions({ app, root, timeout }), { ...request, window })));
  });

// runs a package's bin from cmdless's own package cache, installing it the
// first time, and prints what it printed
program
  .command('package').description('Run a package\'s bin from the cmdless cache, passing the rest of the arguments on')
  .argument('<specifier>', 'Package to run, with a version if wanted (name@version)')
  .argument('[args...]', 'Arguments for the package\'s bin')
  .allowUnknownOption()
  .passThroughOptions()
  .action(async (specifier: string, args: string[]) => {
    process.stdout.write(await runAsPackage({ specifier }, args));
  });

await program.parseAsync();
