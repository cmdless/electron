import { defineConnection } from "../connections.js";
import {
  BrowserMessageReader,
  BrowserMessageWriter,
} from "vscode-jsonrpc/browser";

export const createBrowser = defineConnection(BrowserMessageReader, BrowserMessageWriter);