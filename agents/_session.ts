/**
 * Session module -- private module (starts with _), not mapped as a route.
 *
 * Wraps EdgeOne's context.store (ConversationMemory) to provide a simple
 * session interface for conversation history persistence.
 */

export class ChatSession {
  private store: any;
  private maxHistory: number;

  constructor(store: any, maxHistory = 50) {
    this.store = store;
    this.maxHistory = maxHistory;
  }

  /** Get conversation history as OpenAI-compatible message dicts. */
  async getHistory(conversationId: string): Promise<Array<{ role: string; content: string }>> {
    try {
      // Node.js EdgeOne runtime uses object parameters
      const messages = await this.store.getMessages({
        conversationId,
        limit: this.maxHistory,
        order: 'asc',
      });
      if (this.store.toOpenaiInput) {
        return this.store.toOpenaiInput(messages);
      }
      // Fallback: manual conversion
      return (messages || [])
        .filter((m: any) => m.role === 'user' || m.role === 'assistant')
        .map((m: any) => ({ role: m.role, content: m.content || '' }));
    } catch (e) {
      console.error(`[session] Failed to get history for ${conversationId}:`, e);
      return [];
    }
  }

  /** Save a user message to the store. */
  async saveUserMessage(conversationId: string, content: string): Promise<string> {
    try {
      return await this.store.appendMessage({ conversationId, role: 'user', content });
    } catch (e) {
      console.error('[session] Failed to save user message:', e);
      return '';
    }
  }

  /** Save an assistant message to the store. */
  async saveAssistantMessage(conversationId: string, content: string): Promise<string> {
    try {
      return await this.store.appendMessage({ conversationId, role: 'assistant', content });
    } catch (e) {
      console.error('[session] Failed to save assistant message:', e);
      return '';
    }
  }
}
