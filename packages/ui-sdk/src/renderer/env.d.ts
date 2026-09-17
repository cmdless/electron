import type { Cmdless } from "../index.ts";

declare global {
  interface Window {
    cmdless: Cmdless;
  }
}
