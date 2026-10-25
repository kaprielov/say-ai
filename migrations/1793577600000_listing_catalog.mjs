export function up(pgm) {
  pgm.sql(`
    ALTER TABLE telegram_bots ADD CONSTRAINT telegram_bots_id_owner_catalog_unique UNIQUE (id, owner_id);

    CREATE TABLE listings (
      bot_id bigint NOT NULL,
      owner_id text NOT NULL,
      external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
      title text NOT NULL CHECK (length(btrim(title)) > 0),
      source_url text NOT NULL,
      price_rub integer NOT NULL CHECK (price_rub > 0),
      details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
      reference_size_charts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(reference_size_charts) = 'object'),
      source_assets jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source_assets) = 'object'),
      captured_on date NOT NULL,
      is_test boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (bot_id, external_id),
      UNIQUE (bot_id, external_id, owner_id),
      FOREIGN KEY (bot_id, owner_id) REFERENCES telegram_bots(id, owner_id) ON DELETE CASCADE
    );
    CREATE INDEX listings_owner_idx ON listings(owner_id);

    CREATE TABLE listing_variants (
      bot_id bigint NOT NULL,
      external_id text NOT NULL,
      color text NOT NULL CHECK (length(btrim(color)) > 0),
      size text NOT NULL CHECK (length(btrim(size)) > 0),
      stock integer NOT NULL CHECK (stock >= 0),
      stock_is_synthetic boolean NOT NULL DEFAULT false,
      measurements_cm jsonb NOT NULL CHECK (jsonb_typeof(measurements_cm) = 'object'),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (bot_id, external_id, color, size),
      FOREIGN KEY (bot_id, external_id) REFERENCES listings(bot_id, external_id) ON DELETE CASCADE
    );

    CREATE TABLE telegram_listing_selections (
      bot_id bigint NOT NULL,
      user_id bigint NOT NULL,
      owner_id text NOT NULL,
      external_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (bot_id, user_id),
      FOREIGN KEY (bot_id, external_id, owner_id)
        REFERENCES listings(bot_id, external_id, owner_id) ON DELETE CASCADE
    );

    -- A transferred bot must not expose the previous owner's catalog or selections.
    CREATE FUNCTION clear_transferred_bot_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
        DELETE FROM listings WHERE bot_id = OLD.id;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER telegram_bot_catalog_transfer BEFORE UPDATE OF owner_id ON telegram_bots
      FOR EACH ROW EXECUTE FUNCTION clear_transferred_bot_catalog();

    -- Import the optional manual pilot snapshot without requiring it on new installations.
    -- Keep the original snapshot as a backup; subsequent stock edits use public tables.
    DO $$ BEGIN
      IF to_regclass('test_catalog.listings') IS NOT NULL THEN
        INSERT INTO listings (bot_id, owner_id, external_id, title, source_url, price_rub,
          details, reference_size_charts, source_assets, captured_on, is_test)
        SELECT bot_id, owner_id, external_id, title, source_url, price_rub,
          details, reference_size_charts, source_assets, captured_on, is_test
        FROM test_catalog.listings;
      END IF;
      IF to_regclass('test_catalog.listing_variants') IS NOT NULL THEN
        INSERT INTO listing_variants (bot_id, external_id, color, size, stock,
          stock_is_synthetic, measurements_cm)
        SELECT bot_id, external_id, color, size, stock, stock_is_synthetic, measurements_cm
        FROM test_catalog.listing_variants;
      END IF;
    END $$;
  `);
}

export function down(pgm) {
  pgm.sql(`
    DROP TRIGGER telegram_bot_catalog_transfer ON telegram_bots;
    DROP FUNCTION clear_transferred_bot_catalog();
    DROP TABLE telegram_listing_selections;
    DROP TABLE listing_variants;
    DROP TABLE listings;
    ALTER TABLE telegram_bots DROP CONSTRAINT telegram_bots_id_owner_catalog_unique;
  `);
}
