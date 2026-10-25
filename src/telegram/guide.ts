export const managerIntroduction = `Build a bot that answers using your documents.

1. Connect your OpenAI API key.
2. Add information and test answers.
3. Create a Telegram bot and share it.

Document processing and answers use your OpenAI API billing.`;

export const managerHelp = {
  menu: `Manager help

Create knowledge base — name a collection of information, then send text or up to 10 files together or separately and tap Done. Each file may be up to 20 MB, with 50 MB of files and 5 MiB of extracted text per upload. Supported: TXT, Markdown, CSV, JSON, YAML, PDF, DOCX, DOC. Scans need text recognition before uploading. You can have up to 20 knowledge bases. Processing runs in the background; you receive a notification when it finishes.

My knowledge bases — open a base to check its status, test answers, update content, rename it, create a bot, or delete it.

My bots — open a bot to see its link, choose its knowledge base, pause and enable answers, or configure Spam protection. Protection settings include visitor quotas, duplicate suppression, off-topic warnings and pauses, and owner notifications. Restricted visitors can be unblocked here. Server safety limits always apply.

Settings → Owner limits — optional daily quotas for customer questions and tests, counted separately. Both default to no daily quota.

Settings → OpenAI key — securely connect, replace, or remove the key used for all your knowledge bases and bots. Document processing and answers use your OpenAI API account and billing. Never paste a key into this chat.

Settings → Language — change the interface language.

Previous / Next — browse more items in a list.
Main menu or /start — return to the menu and leave the current input step.
/cancel — leave the current input step and return to the menu. Already accepted uploads keep processing.
/help — open short help without losing your current input step. Full guide opens the detailed instructions.
/settings — open account settings.

Choose a help topic below for details.`,
  base: `Knowledge base help

A knowledge base contains the information your bots use to answer questions. Keep its content accurate and test common questions before sharing a bot.

Refresh status — check processing progress. Pending means queued; processing means work is in progress; ready means processing succeeded; failed means you should replace the content to try again. Answers available indicates whether a ready version exists, even while an update is processing.

Test answers — send questions here to check the base before sharing a bot. Each question uses your OpenAI API account and a separate configurable daily test allowance. Use /cancel to finish testing.

Replace content — collect new files or text and tap Done to replace the entire base. The same upload limits apply. Include everything you want to keep. The previous ready version remains available during processing. Connected bots use the new version once it is ready.

Rename — change the base's display name. Its content and bot connections stay the same. Names must contain 1 to 80 characters.

Create Telegram bot — available when a ready version exists. Tap the button below the message field, then choose a name and username in Telegram. The new bot is connected to this base and starts answering immediately. Open its link to test it and share the link when you are satisfied.

Delete knowledge base — asks for confirmation. Delete permanently removes the base and its content and pauses connected bots. Cancel keeps the base. Wait for processing to finish before deleting.

View knowledge base — open the base after submitting content.
Main menu — leave the current input step and return to the menu.`,
  bot: `Telegram bot help

Your bot is the public entry point for people to ask questions. It answers in private chats using its selected knowledge base. Open the t.me link in its card to try it or share the link with others.

Answer settings — edit bot instructions (up to 4000 characters), answer detail, response language, and context selection. Changes stay in a draft until you publish. Publication does not enable a paused bot. Restore previous version switches back to the previous published settings and keeps unfinished draft edits. The last 20 published versions are retained. Source evidence and moderation rules still apply.

Test bot — choose the published version or draft and send questions. Tests use your API key and test allowance, without sending messages or applying penalties to visitors. Retrieved context and Full model request show the exact selected evidence and assembled generation payload. Details are stored locally until you leave testing, for up to 24 hours, and are also sent into your private manager conversation. If settings change, choose the test version again.

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


export const russianManagerIntroduction = `Создайте бота, который отвечает по вашим документам.

1. Подключите API-ключ OpenAI.
2. Добавьте информацию и проверьте ответы.
3. Создайте Telegram-бота и поделитесь ссылкой.

Обработка документов и ответы оплачиваются с вашего API-аккаунта OpenAI.`;

export const russianManagerHelp: Record<HelpTopic, string> = {
  menu: `Справка по менеджеру

Создать базу знаний — задайте название, затем отправьте текст или до 10 файлов вместе либо по очереди и нажмите «Готово». Каждый файл — до 20 МБ, все файлы — до 50 МБ, извлечённый текст — до 5 МиБ. Форматы: TXT, Markdown, CSV, JSON, YAML, PDF, DOCX, DOC. Текст сканов нужно распознать до загрузки. Можно создать до 20 баз знаний. Обработка идёт в фоне; вы получите уведомление о её завершении.

Мои базы знаний — откройте базу, чтобы проверить статус и ответы, обновить содержимое, изменить название, создать бота или удалить базу.

Мои боты — откройте бота, чтобы получить ссылку, выбрать базу знаний, приостановить или включить ответы, настроить защиту от спама. В защите настраиваются квоты посетителей, повторы, предупреждения, сроки пауз и уведомления владельцу. Там же можно снять ограничение с посетителя. Технические ограничения сервера действуют всегда.

Настройки → Лимиты владельца — необязательные дневные квоты для вопросов клиентов и тестов, которые считаются отдельно. По умолчанию обе квоты отключены.

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

Проверить ответы — задавайте вопросы здесь перед публикацией бота. Каждый вопрос использует ваш API-аккаунт OpenAI и отдельный настраиваемый дневной лимит тестирования. Команда /cancel завершает проверку.

Заменить содержимое — отправьте новые файлы или текст и нажмите «Готово» для полной замены базы. Действуют те же ограничения загрузки. Включите всё, что хотите сохранить. Во время обработки доступна предыдущая готовая версия. После завершения связанные боты начнут использовать новую версию.

Переименовать — измените название базы. Содержимое и связи с ботами сохраняются. Длина названия — от 1 до 80 символов.

Создать Telegram-бота — доступно, когда есть готовая версия базы. Нажмите кнопку под полем ввода и выберите имя и адрес бота в окне Telegram. Новый бот подключится к этой базе и сразу начнёт отвечать. Откройте его ссылку для проверки и поделитесь ею, когда будете довольны результатом.

Удалить базу знаний — требует подтверждения. «Удалить навсегда» удаляет базу и всё содержимое, а связанные боты приостанавливаются. «Отмена» сохраняет базу. Перед удалением дождитесь завершения обработки.

Открыть базу знаний — перейдите к базе после отправки содержимого.
Главное меню — завершите текущий шаг ввода и вернитесь в меню.`,
  bot: `Справка по Telegram-боту

Ваш бот — место, где пользователи задают вопросы. Он отвечает в личных чатах по выбранной базе знаний. Откройте ссылку t.me в его карточке для проверки или отправьте её другим людям.

Настройки ответов — измените инструкции бота (до 4000 символов), подробность, язык и подбор контекста. Изменения сохраняются в черновик до публикации. Публикация не включает приостановленного бота. Возврат прошлой версии сохраняет незавершённый черновик. Хранятся последние 20 опубликованных версий. Правила работы с источниками и модерации сохраняются.

Тестировать бота — выберите опубликованную версию или черновик и задавайте вопросы. Используются ваш API-ключ и квота тестов; посетители не получают сообщения и ограничения. «Найденный контекст» и «Полный запрос к модели» показывают выбранные фрагменты и собранный запрос. Подробности хранятся локально до выхода из тестирования, не дольше 24 часов, а также отправляются в ваш личный чат с менеджером. Если настройки изменились, выберите версию для теста заново.

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
