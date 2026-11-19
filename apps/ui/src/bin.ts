#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { Argument, Command } from 'commander';
import { types } from '@cmdless/ui-sdk';
import type { ElicitationRequest, PermissionRequest } from '@cmdless/ui-sdk';
import { runAsPackage, UIHost } from '@cmdless/ui-sdk/node';
import type { CreateHostOptions, WindowParams } from '@cmdless/ui-sdk/node';

// how a one-shot command prints the value it ended with
const binOutput = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);

// the host to show it on (--app, --root, --timeout), and how its window
// looks (--width, --height, --title)
type HostFlags = { app?: string; root?: string; timeout?: number };
type WindowFlags = { width?: number; height?: number; title?: string };

// the options every command takes for its host
const onHost = (command: Command) => command
  .option('--app <name>', 'App name: the host to show it on, joined if it is already running')
  .option('--root <path>', 'cmdless root to run the host from')
  .option('--timeout <ms>', 'How long the host gets to start', Number);

// the options a command showing a window takes for how it looks
const inWindow = (command: Command, title = 'Title of the window') => command
  .option('--width <number>', 'Width of the window', Number)
  .option('--height <number>', 'Height of the window', Number)
  .option('--title <title>', title);

// a command's options split in two: the host's, as UIHost wants them, and
// the rest
function hostFrom<O extends HostFlags>({ app, root, timeout, ...rest }: O) {
  const host: CreateHostOptions = { app, cmdlessRoot: root, timeoutMs: timeout };
  return [host, rest] as const;
}

const program = new Command().name('ui').enablePositionalOptions();

// shows a window on a host - this one's own, unless --app names one to join -
// and prints the value it ends with
inWindow(onHost(program
  .command('window').description('Show a window, and print the value it ends with')
  .addArgument(new Argument('<type>', 'Source type to show in the window').choices(types.ShowTypes))
  .argument('<source>', 'File or URL to open in the window')), 'Title of the window, kept whatever the page calls itself')
  .option('--redirect <prefix>', 'End the window when it navigates to a URL starting with this, resolving to that URL')
  .option('--external', 'Show a third party\'s pages: no preload, a browser user agent, popups as child windows')
  .action(async (type: types.ShowType, source: string, options: Pick<WindowParams, 'redirect' | 'external'> & HostFlags & WindowFlags) => {
    const [host, { width, height, title, ...page }] = hostFrom(options);
    process.stdout.write(binOutput(await UIHost.showWindow({ type, source, ...page, window: { width, height, title } }, host)));
  });

// --button can be given more than once, each adding a button
const collect = (value: string, previous: string[] = []) => [...previous, value];

type DialogFlags = HostFlags & {
  detail?: string; button?: string[]; default?: number; cancel?: number; checkbox?: string; checked?: boolean;
};

// shows a message box on a host, and prints what was chosen: the button's
// index, and whether the checkbox ended ticked
onHost(program
  .command('dialog').description('Show a message box, and print the button that was chosen')
  .addArgument(new Argument('<type>', 'Type of message').choices(types.MessageBoxTypes))
  .argument('<message>', 'Message to show')
  .option('--detail <text>', 'Smaller text under the message')
  .option('--button <label>', 'A button to choose from, in order - repeat for more (default: OK)', collect)
  .option('--default <index>', 'Index of the button Enter chooses', Number)
  .option('--cancel <index>', 'Index of the button Escape (or closing it) chooses', Number)
  .option('--checkbox <label>', 'A checkbox under the message')
  .option('--checked', 'Start the checkbox ticked'))
  .action(async (type: types.MessageBoxType, message: string, options: DialogFlags) => {
    const [host, { detail, button: buttons, default: defaultId, cancel: cancelId, checkbox: checkboxLabel, checked: checkboxChecked }] = hostFrom(options);
    const value = await UIHost.showDialog(
      { type, message, detail, buttons, defaultId, cancelId, checkboxLabel, checkboxChecked },
      host,
    );
    process.stdout.write(binOutput(value));
  });

// a JSON file's contents
const readJson = async <T>(file: string) => JSON.parse(await readFile(file, 'utf8')) as T;

// shows an Adaptive Card on a host, and prints the Action.Submit chosen on
// it - nothing, and exit code 1, if it was closed instead
inWindow(onHost(program
  .command('card').description('Show an Adaptive Card, and print the Submit action chosen on it with its inputs')
  .argument('<file>', 'Adaptive Card JSON file (already expanded: no ${} bindings)')
  .option('--host-config <file>', 'Adaptive Cards host config JSON file')))
  .action(async (file: string, options: HostFlags & WindowFlags & { hostConfig?: string }) => {
    const [host, { hostConfig, ...window }] = hostFrom(options);
    const value = await UIHost.showCard({
      window,
      card: await readJson(file),
      hostConfig: hostConfig ? await readJson(hostConfig) : undefined,
    }, host);
    if (value === undefined) process.exitCode = 1;
    else process.stdout.write(binOutput(value));
  });

// shows a JSON Schema form on a host, and prints the data it was submitted
// with - nothing, and exit code 1, if it was cancelled
inWindow(onHost(program
  .command('form').description('Show a JSON Schema form, and print the data it was submitted with')
  .argument('<schema>', 'JSON Schema file')
  .option('--ui-schema <file>', 'react-jsonschema-form uiSchema JSON file')
  .option('--data <file>', 'JSON file of the values to start with')
  .option('--submit-text <text>', 'What the submit button says')))
  .action(async (schema: string, options: HostFlags & WindowFlags & { uiSchema?: string; data?: string; submitText?: string }) => {
    const [host, { uiSchema, data, submitText, ...window }] = hostFrom(options);
    const value = await UIHost.showForm({
      window,
      submitText,
      schema: await readJson(schema),
      uiSchema: uiSchema ? await readJson(uiSchema) : undefined,
      formData: data ? await readJson(data) : undefined,
    }, host);
    if (value === undefined) process.exitCode = 1;
    else process.stdout.write(binOutput(value));
  });

// asks an elicitation (MCP's or ACP's, form mode) as a card, and prints its
// answer: { action: accept, content } or { action: decline | cancel }
inWindow(onHost(program
  .command('elicit').description('Ask an elicitation as a card, and print its result')
  .argument('<file>', 'JSON file of the request: { message, requestedSchema }')))
  .action(async (file: string, options: HostFlags & WindowFlags) => {
    const [host, window] = hostFrom(options);
    const request = await readJson<ElicitationRequest>(file);
    process.stdout.write(binOutput(await UIHost.showElicitation({ ...request, window }, host)));
  });

// asks a permission request (ACP's) as a card, and prints its outcome:
// { outcome: selected, optionId } or { outcome: cancelled }
inWindow(onHost(program
  .command('permission').description('Ask a permission request as a card, and print its outcome')
  .argument('<file>', 'JSON file of the request: { title, description?, options: [{ optionId, name, kind }] }')))
  .action(async (file: string, options: HostFlags & WindowFlags) => {
    const [host, window] = hostFrom(options);
    const request = await readJson<PermissionRequest>(file);
    process.stdout.write(binOutput(await UIHost.showPermission({ ...request, window }, host)));
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
