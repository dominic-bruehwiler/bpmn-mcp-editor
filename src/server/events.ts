/** Pushes diagram and lock changes to every connected browser. */
import type { ProcessDetails } from "./state";

export type ServerEvent =
  | { type: "process.updated"; process: ProcessDetails }
  | { type: "process.deleted"; id: string };

type Listener = (message: string) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publish(event: ServerEvent): void {
  const message = JSON.stringify(event);
  for (const listener of listeners) {
    try {
      listener(message);
    } catch (error) {
      console.error("Failed to push a diagram update.", error);
      listeners.delete(listener);
    }
  }
}
