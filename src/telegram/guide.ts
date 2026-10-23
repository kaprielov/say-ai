export const managerIntroduction = `Manage your knowledge bases and Telegram bots.

This manager helps you build Telegram bots that answer questions using your documents. A knowledge base is the information a bot uses; your bot is where people ask questions.

You are the owner: provide accurate content, test the answers, keep information up to date, and decide when your bots can answer. The manager handles document processing and connects your bots to their knowledge bases.

To get started:
1. Connect your OpenAI API key. Processing documents and answering questions use your OpenAI API account and billing.
2. Create a knowledge base: give it a name and send your text or a file.
3. Wait for processing, test answers, then create a Telegram bot from the knowledge base and share its link.

Use Help to learn what each action does.`;

export const managerHelp = {
  menu: `Manager help

Create knowledge base — name a collection of information, then paste text or upload one file up to 1 MiB. Supported: TXT, Markdown, CSV, JSON, YAML, PDF, DOCX, DOC. Scans need text recognition before uploading. You can have up to 20 knowledge bases. Processing runs in the background; you receive a notification when it finishes.

My knowledge bases — open a base to check its status, test answers, update content, rename it, create a bot, or delete it.

My bots — open a bot to see its link, choose its knowledge base, or pause and enable answers.

OpenAI key — securely connect, replace, or remove the key used for all your knowledge bases and bots. Document processing and answers use your OpenAI API account and billing. Never paste a key into this chat.

Language — change the interface language.

Previous / Next — browse more items in a list.
Main menu or /start — return to the menu and leave the current input step.
/cancel — leave the current input step and return to the menu. Already accepted uploads keep processing.
/help — open this guide without losing your current input step.

Choose a help topic below for details.`,
  base: `Knowledge base help

A knowledge base contains the information your bots use to answer questions. Keep its content accurate and test common questions before sharing a bot.

Refresh status — check processing progress. Pending means queued; processing means work is in progress; ready means processing succeeded; failed means you should replace the content to try again. Answers available indicates whether a ready version exists, even while an update is processing.

Test answers — send questions here to check the base before sharing a bot. Each question uses your OpenAI API account and the same daily question allowance as your bots. Use /cancel to finish testing.

Replace content — send a new file or text to replace the entire base, not append to it. Include everything you want to keep. The previous ready version remains available during processing. Connected bots use the new version once it is ready.

Rename — change the base's display name. Its content and bot connections stay the same. Names must contain 1 to 80 characters.

Create Telegram bot — available when a ready version exists. Tap the button below the message field, then choose a name and username in Telegram. The new bot is connected to this base and starts answering immediately. Open its link to test it and share the link when you are satisfied.

Delete knowledge base — asks for confirmation. Delete permanently removes the base and its content and pauses connected bots. Cancel keeps the base. Wait for processing to finish before deleting.

View knowledge base — open the base after submitting content.
Main menu — leave the current input step and return to the menu.`,
  bot: `Telegram bot help

Your bot is the public entry point for people to ask questions. It answers in private chats using its selected knowledge base. Open the t.me link in its card to try it or share the link with others.

Choose knowledge base — select one of your bases for this bot. Changing the base pauses answers; check the new selection and enable answers when ready.

Publish / enable answers — allow people to receive answers. A selected knowledge base with a ready version and an available OpenAI API key are required.

Pause answers — stop answering questions until you enable answers again. The bot and its knowledge-base connection are kept.

Main menu — return to your knowledge bases, bots, and settings.`,
  key: `OpenAI key help

Connect OpenAI key — open the secure Telegram form and submit your OpenAI API key there. Do not send it as a chat message. The key needs access to document embeddings and the answering model, with API billing available.

Replace OpenAI key — submit another key through the same form. It will be used for all your knowledge bases and bots. Processing documents and answering questions use that key's OpenAI API account and billing.

Remove OpenAI key — asks for confirmation. Remove key disconnects your saved key; your bots stop answering until you connect another key. Cancel keeps the key.

Main menu — return to the manager.`,
} as const;

export type HelpTopic = keyof typeof managerHelp;


export const russianManagerIntroduction = `Управляйте базами знаний и Telegram-ботами.

Этот менеджер помогает создавать Telegram-ботов, которые отвечают на вопросы по вашим документам. База знаний — это информация для ответов, а бот — место, где пользователи задают вопросы.

Вы — владелец: предоставляете достоверные материалы, проверяете ответы, обновляете информацию и решаете, когда бот может отвечать. Менеджер обрабатывает документы и связывает ботов с базами знаний.

С чего начать:
1. Подключите свой API-ключ OpenAI. Обработка документов и ответы расходуют средства вашего API-аккаунта OpenAI.
2. Создайте базу знаний: задайте название и отправьте текст или файл.
3. Дождитесь обработки, проверьте ответы, затем создайте Telegram-бота из базы знаний и поделитесь ссылкой.

Кнопка «Справка» объясняет каждое действие.`;

export const russianManagerHelp: Record<HelpTopic, string> = {
  menu: `Справка по менеджеру

Создать базу знаний — задайте название, затем отправьте текст или один файл до 1 МиБ. Форматы: TXT, Markdown, CSV, JSON, YAML, PDF, DOCX, DOC. Текст сканов нужно распознать до загрузки. Можно создать до 20 баз знаний. Обработка идёт в фоне; вы получите уведомление о её завершении.

Мои базы знаний — откройте базу, чтобы проверить статус и ответы, обновить содержимое, изменить название, создать бота или удалить базу.

Мои боты — откройте бота, чтобы получить ссылку, выбрать базу знаний, приостановить или включить ответы.

Ключ OpenAI — подключите, замените или удалите ключ для всех ваших баз знаний и ботов через защищённую форму. Обработка документов и ответы расходуют средства вашего API-аккаунта OpenAI. Не отправляйте ключ в чат.

Язык — измените язык интерфейса.

Назад / Далее — переходите между страницами списка.
Главное меню или /start — вернитесь в меню, завершив текущий шаг ввода.
/cancel — завершите текущий шаг ввода и вернитесь в меню. Уже принятые материалы продолжат обрабатываться.
/help — откройте справку, сохранив текущий шаг ввода.

Выберите тему справки ниже.`,
  base: `Справка по базе знаний

База знаний содержит информацию, по которой ваши боты отвечают на вопросы. Поддерживайте её актуальность и проверяйте типичные вопросы перед тем, как делиться ботом.

Обновить статус — проверьте ход обработки. «Ожидает обработки» означает очередь; «обрабатывается» — работа идёт; «готова» — обработка завершена; при ошибке замените содержимое, чтобы повторить попытку. «Можно задавать вопросы» показывает, есть ли готовая версия, в том числе во время обновления.

Проверить ответы — задавайте вопросы здесь перед публикацией бота. Каждый вопрос использует ваш API-аккаунт OpenAI и тот же дневной лимит, что и ваши боты. Команда /cancel завершает проверку.

Заменить содержимое — отправьте новый файл или текст для полной замены базы, а не добавления к ней. Включите всё, что хотите сохранить. Во время обработки доступна предыдущая готовая версия. После завершения связанные боты начнут использовать новую версию.

Переименовать — измените название базы. Содержимое и связи с ботами сохраняются. Длина названия — от 1 до 80 символов.

Создать Telegram-бота — доступно, когда есть готовая версия базы. Нажмите кнопку под полем ввода и выберите имя и адрес бота в окне Telegram. Новый бот подключится к этой базе и сразу начнёт отвечать. Откройте его ссылку для проверки и поделитесь ею, когда будете довольны результатом.

Удалить базу знаний — требует подтверждения. «Удалить навсегда» удаляет базу и всё содержимое, а связанные боты приостанавливаются. «Отмена» сохраняет базу. Перед удалением дождитесь завершения обработки.

Открыть базу знаний — перейдите к базе после отправки содержимого.
Главное меню — завершите текущий шаг ввода и вернитесь в меню.`,
  bot: `Справка по Telegram-боту

Ваш бот — место, где пользователи задают вопросы. Он отвечает в личных чатах по выбранной базе знаний. Откройте ссылку t.me в его карточке для проверки или отправьте её другим людям.

Выбрать базу знаний — выберите одну из ваших баз для этого бота. Смена базы приостанавливает ответы; проверьте выбор и включите ответы, когда будете готовы.

Включить ответы — разрешите боту отвечать пользователям. Нужны выбранная база знаний с готовой версией и доступный API-ключ OpenAI.

Приостановить ответы — остановите ответы до следующего включения. Бот и его связь с базой знаний сохраняются.

Главное меню — вернитесь к базам знаний, ботам и настройкам.`,
  key: `Справка по ключу OpenAI

Подключить ключ OpenAI — откройте защищённую форму Telegram и отправьте API-ключ OpenAI через неё. Не отправляйте ключ сообщением в чат. Ключу нужен доступ к модели обработки документов (embeddings) и модели ответов, а также средства на API-аккаунте.

Заменить ключ OpenAI — отправьте другой ключ через ту же форму. Он будет использоваться для всех ваших баз знаний и ботов. Обработка документов и ответы расходуют средства API-аккаунта, которому принадлежит ключ.

Удалить ключ OpenAI — требует подтверждения. «Удалить ключ» отключает сохранённый ключ; боты перестанут отвечать, пока вы не подключите другой. «Отмена» сохраняет ключ.

Главное меню — вернитесь в менеджер.`,
};
