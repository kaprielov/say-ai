# Try Say AI

Say AI helps you create a Telegram bot that answers questions using information
you provide. Upload a document or paste text, check the answers, and create a bot
you can share. No programming is required.

It is intended for people who repeatedly explain the same information: a small
business answering customer questions, a course organizer explaining schedules and
rules, or a community sharing a guide. For example, a shop could supply its delivery
and return policies so visitors can ask about them in Telegram.

This first test is about usefulness: can you turn your own information into a bot
you would want to use again? Honest criticism and getting stuck are useful results.
You do not need to prepare a formal test report.

## Before you start

- Agree on a testing time with Anton and use the manager-bot link he sends you.
  The service currently runs on his laptop and is available while it is running
  and connected to the internet.
- Choose a short document you know well and keep the original. Use material you
  are comfortable sharing with this test service, Telegram, and OpenAI; avoid
  sensitive customer information.
- You need your own OpenAI API key with API billing and access to the required
  models. Key verification, document processing, and answers can incur charges on
  that account. If this setup is unfamiliar, ask Anton for help before proceeding.
  Enter the key only in the secure form opened from the manager, never in chat
  or feedback.

## What to try

Allow roughly 15–20 minutes for a first session; pause and ask for help if needed.

1. Open the manager, send `/start`, choose a language, and connect your API key.
2. Create a knowledge base: give your information a name, then send text or a file.
   Wait for the notification that processing is complete.
3. Try a few questions you would actually receive from customers or participants.
   Five to ten questions is a useful starting point, not a required quota. Include
   something clearly covered by the document, a differently worded question, and
   something the document does not explain.
4. Create a Telegram bot from the ready base and open its link. Ask a question
   there too; if convenient, have another person try it privately.
5. Send Anton your impression and any examples using the
   [feedback guide](feedback.md). Mention where you needed help as well as bugs.

If you want to explore further, try changing the answer style or updating the
document. These are optional; completing the main flow is enough for a first test.

## Current limits

- This is an early prototype. It may be unavailable, slow, or reset during
  development. Keep copies of your materials; do not rely on it for daily work yet.
- A base accepts one file per upload, up to 1 MiB. Supported formats include TXT,
  Markdown, CSV, JSON, YAML, PDF, DOCX, and DOC. Scans and image-only documents need
  text recognition before uploading.
- Updating a base replaces its entire content; it does not add another document.
  Include everything you want to keep in the replacement.
- Bots answer in private Telegram chats. Previous conversation messages are not
  supplied to the model, so ask self-contained questions rather than relying on
  follow-ups such as "And how much is that?"
- The bot is intended to use your supplied information. It can still make mistakes,
  miss information, or decline a question. Check important answers against your
  document and report invented facts or incorrect restrictions.
- A new bot created from a ready base starts answering immediately. Try it before
  sharing the link more widely. You can pause answers from its card in My bots.
- Visitor limits and duplicate suppression may temporarily prevent replies. Report
  unexpected restrictions instead of repeatedly resending the same question.

If the bot stops responding, message Anton with the approximate time and what you
were trying to do. You do not need to diagnose the problem yourself.
