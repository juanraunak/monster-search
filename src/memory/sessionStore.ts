import { ChatMessage } from '../types';

const sessionStore = new Map<string, ChatMessage[]>();

export function getSession(sessionId: string): ChatMessage[] {
  if (!sessionStore.has(sessionId)) {
    sessionStore.set(sessionId, []);
  }
  return sessionStore.get(sessionId)!;
}

export function updateSession(sessionId: string, newMessage: ChatMessage) {
  const history = getSession(sessionId);
  history.push(newMessage);
}
