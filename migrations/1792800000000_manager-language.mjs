export function up(pgm) {
  pgm.sql("ALTER TABLE telegram_sessions ADD COLUMN language text CHECK (language IN ('en', 'ru'))");
}

export function down(pgm) {
  pgm.sql('ALTER TABLE telegram_sessions DROP COLUMN language');
}
