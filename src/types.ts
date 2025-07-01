export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface ExtractedData {
  topic: string;
  intent: string;
}
