export function up(pgm) {
  pgm.sql(`
    ALTER TABLE telegram_bots ADD COLUMN answer_settings jsonb NOT NULL DEFAULT
      jsonb_build_object('version', gen_random_uuid(), 'draft', null,
        'published', jsonb_build_object('id', gen_random_uuid(), 'settings',
          jsonb_build_object('instructions','','detail','standard','language','auto','retrieval','balanced')),
        'history', '[]'::jsonb);
    ALTER TABLE telegram_sessions ADD COLUMN tuning_bot_id bigint,
      ADD COLUMN tuning_version uuid,
      ADD COLUMN tuning_mode text, ADD COLUMN tuning_result jsonb;
  `);
}
export function down(pgm) {
  pgm.sql(`ALTER TABLE telegram_sessions DROP COLUMN tuning_result, DROP COLUMN tuning_mode, DROP COLUMN tuning_version, DROP COLUMN tuning_bot_id;
    ALTER TABLE telegram_bots DROP COLUMN answer_settings;`);
}
