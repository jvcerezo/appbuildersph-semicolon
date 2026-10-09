import { ServerMessageSchema, withVersion, type ServerMessage, type Unversioned } from '@linaw/contract';

export type Outgoing = Unversioned<ServerMessage>;

/** JSON for the UI, or null when the message breaks the contract (a backend bug, logged loudly). */
export function encode(message: Outgoing): string | null {
  const full = withVersion(message);
  const result = ServerMessageSchema.safeParse(full);
  if (result.success) return JSON.stringify(result.data);
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  console.error(`[backend] BUG: "${message.type}" does not match the contract and was not sent (${issues})`, full);
  return null;
}
