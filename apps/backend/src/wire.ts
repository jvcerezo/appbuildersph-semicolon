import { ServerMessageSchema, withVersion, type ServerMessage, type Unversioned } from '@linaw/contract';

/** A server message before `v` is added. */
export type Outgoing = Unversioned<ServerMessage>;

/**
 * Turns a message into the JSON text sent to the UI, or `null` if it doesn't
 * match the contract. A mismatch is a backend bug, so it is logged loudly and
 * never sent: the UI would drop it anyway.
 */
export function encode(message: Outgoing): string | null {
  const full = withVersion(message);
  const result = ServerMessageSchema.safeParse(full);
  if (result.success) return JSON.stringify(result.data);
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  console.error(`[backend] BUG: "${message.type}" does not match the contract and was not sent (${issues})`, full);
  return null;
}
