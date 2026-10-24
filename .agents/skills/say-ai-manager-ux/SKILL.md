---
name: say-ai-manager-ux
description: Improve Say AI's Telegram manager interface, including menus, settings, and navigation. Use when implementing or reviewing manager UX and copy; exclude backend-only RAG and infrastructure work.
---

# Say AI Manager UX

Preserve a compact Telegram interface: users should find their next action, understand its effect, and return without losing their place. Apply these principles to the requested flow rather than redesigning unrelated screens.

## Interaction decisions

- Put frequent actions on the relevant bot or knowledge-base card. Group account preferences separately and place occasional or destructive actions behind a clearly named secondary entry. Keep destructive confirmations explicit.
- Start settings with a short explanation, the current value, and useful preset buttons. Allow custom input when needed. Reveal examples and edge cases through Details. Keep essential consequences, units, and the meaning of zero visible before applying a value.
- Group related settings by user purpose. Prefer short paginated lists; page size and button counts are design choices, not universal requirements.
- Make Back return to the parent or originating screen. Preserve the list page and target object where practical. Help should preserve an unfinished input step and offer a way to resume it. Keep a clear escape to the main menu.
- Prefer updating a clicked inline panel for navigation. Keep ordinary sends for user-input replies, announcements, and native reply-keyboard actions. After such a send, keep the next actionable menu at the bottom of the chat rather than editing an older message above it.
- Reuse the durable outbox for sends and edits. Treat unchanged edits as complete; recover from an uneditable or deleted panel with a normal message. Preserve per-chat ordering and existing capacity bounds.
- Carry target identities in callbacks instead of relying on unrelated session state. Check ownership on the server for every referenced bot and knowledge base. Keep callbacks within Telegram's byte limit and handle stale controls safely.
- Keep Russian as the default and update every supported translation together through the localization system. Use plain labels and user-facing consequences rather than internal implementation terms. Keep API keys in the existing secure form, never in chat input.

Keep actual quota values, pause lengths, and operator limits in configuration and application code. Explain their current behavior accurately; this skill does not prescribe those numbers.

## Work with the existing application

Before editing a flow, trace its entry point, session transitions, feedback, and return route. Reuse the existing implementation rather than introducing a separate navigation or delivery system:

- [Manager service](../../../src/telegram/service.ts): panels, callbacks, ownership, and session transitions.
- [Localization](../../../src/telegram/i18n.ts) and [help copy](../../../src/telegram/guide.ts): supported languages and optional detailed guidance.
- [Protection settings](../../../src/telegram/protection.ts): actual rule semantics, including zero values.
- [Telegram worker](../../../src/telegram/worker.ts): durable delivery, retries, and edit recovery.
- [Project README](../../../README.md#telegram-interface): setup and current manager behavior. Inspect nearby UI configuration modules when present.

For navigation, callback, or session changes, run the build and relevant Telegram tests with controlled transports. Cover meaningful behaviors such as returning from help to input, keeping the originating page, rejecting another owner's callbacks, custom-value validation, and edit recovery. When credential flows change, include the owner-key tests. For copy-only changes, review clarity and translation coverage without adding tests that merely duplicate wording.

## Design references

- [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/): prioritize common actions and reveal secondary detail on demand.
- [Optional details](https://design-system.service.gov.uk/components/details/): keep secondary help accessible without hiding essential information.
- [Telegram message editing](https://core.telegram.org/bots/api#editmessagetext): use native capabilities for compact panel navigation.

Treat these as design guidance. Adapt the interface to demonstrated user needs and do not claim measured usability improvements without user evidence.
