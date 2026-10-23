import type { TelegramTransport } from './client.js';

// Chat actions expire after five seconds. Send them directly: the outbox is
// delivered only after the answer transaction commits.
export function startTyping(api: TelegramTransport, token: Promise<string>, chat: number) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function send() {
    try {
      const value = await token;
      if (stopped) return;
      await api.call(value, 'sendChatAction', { chat_id: chat, action: 'typing' });
      if (!stopped) {
        timer = setTimeout(() => { void send(); }, 4000);
        timer.unref();
      }
    } catch {
      // A cosmetic status must never delay or prevent an answer. Stop sending
      // after an error, including rate limits, rather than retrying the action.
      stopped = true;
    }
  }

  void send();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
