import type { ProtectionKey } from './protection.js';

export const protectionGroups = {
  messages: { label: 'Message limits', keys: ['perMinute', 'perDay', 'duplicateSeconds'] },
  topic: { label: 'Off-topic questions', keys: ['strikes', 'windowMinutes', 'pauseMinutes', 'repeatHours', 'repeatWindowHours'] },
  notices: { label: 'Notifications', keys: ['notifications', 'noticeMinutes'] },
} satisfies Record<string, { label: string; keys: ProtectionKey[] }>;
export type ProtectionGroup = keyof typeof protectionGroups;
export const protectionGroupFor = (key: ProtectionKey): ProtectionGroup =>
  Object.entries(protectionGroups).find(([, group]) => (group.keys as ProtectionKey[]).includes(key))![0] as ProtectionGroup;

export const protectionHints: Record<ProtectionKey, string> = {
  perMinute: 'Questions per visitor per minute. Zero keeps only the server limit of 30/min.',
  perDay: 'Questions per visitor per calendar day. Zero removes the daily quota.',
  duplicateSeconds: 'Ignore the same question sent again within this many seconds. Zero allows repeats.',
  strikes: 'Warn after this many off-topic questions. Continuing after the warning can pause answers. Zero disables topic enforcement.',
  windowMinutes: 'Count off-topic questions during this many minutes, starting with the first. Zero disables topic enforcement.',
  pauseMinutes: 'Minutes without answers after a visitor ignores the warning. Zero disables the first pause.',
  repeatHours: 'Hours without answers for another abuse episode after an earlier pause. Zero disables this pause.',
  repeatWindowHours: 'Hours after a pause ends during which new abuse counts as repeated. Zero turns off repeat detection.',
  notifications: 'Notify you about repeated-abuse pauses: 1 = on, 0 = off.',
  noticeMinutes: 'Group further restriction notices over this many minutes. Zero uses the server minimum of one minute.',
};

export const protectionPresets: Record<ProtectionKey, number[]> = {
  perMinute: [3, 5, 10], perDay: [10, 30, 100], duplicateSeconds: [30, 60, 120],
  strikes: [2, 3, 5], windowMinutes: [5, 10, 30], pauseMinutes: [5, 15, 30],
  repeatHours: [1, 6, 24], repeatWindowHours: [12, 24, 72],
  notifications: [1, 0], noticeMinutes: [5, 15, 60],
};

export const helpSummaries = {
  menu: 'Create a knowledge base, test its answers, then connect a bot. Account settings contain your API key, language, and daily quotas.',
  base: 'Upload the information your bot should use. Test common questions before publishing. Replacing content keeps the previous version available until the update is ready.',
  bot: 'Tune answers in Answer settings, test a draft, then publish it. You can also choose a knowledge base, pause answers, and adjust spam protection.',
  key: 'Connect your own OpenAI API key. Document processing and answers use your API billing. Enter the key only in the secure form.',
} as const;
