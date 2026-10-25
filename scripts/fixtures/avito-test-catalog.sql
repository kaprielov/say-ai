-- Manual pilot data only. This schema is not consumed by the answering pipeline.
-- Imported listing titles are source data, not application interface strings.
-- Re-running keeps manually edited listings and stock unchanged.
BEGIN;

CREATE SCHEMA IF NOT EXISTS test_catalog;

CREATE TABLE IF NOT EXISTS test_catalog.listings (
  bot_id bigint NOT NULL REFERENCES public.telegram_bots(id),
  owner_id text NOT NULL,
  external_id text NOT NULL,
  title text NOT NULL,
  source_url text NOT NULL,
  price_rub integer NOT NULL CHECK (price_rub > 0),
  details jsonb NOT NULL,
  reference_size_charts jsonb NOT NULL,
  source_assets jsonb NOT NULL,
  captured_on date NOT NULL,
  is_test boolean NOT NULL DEFAULT true CHECK (is_test),
  PRIMARY KEY (bot_id, external_id)
);

CREATE TABLE IF NOT EXISTS test_catalog.listing_variants (
  bot_id bigint NOT NULL,
  external_id text NOT NULL,
  color text NOT NULL,
  size text NOT NULL,
  stock integer NOT NULL CHECK (stock >= 0),
  stock_is_synthetic boolean NOT NULL DEFAULT true CHECK (stock_is_synthetic),
  measurements_cm jsonb NOT NULL,
  PRIMARY KEY (bot_id, external_id, color, size),
  FOREIGN KEY (bot_id, external_id)
    REFERENCES test_catalog.listings(bot_id, external_id)
);

-- Fail before writing data if the intended bot has changed owners.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.telegram_bots
    WHERE id = 8785889729 AND owner_id = 'telegram:264147129'
      AND lower(username) = 'antontest111bot123bot'
  ) THEN
    RAISE EXCEPTION 'Test bot ownership does not match the authorized owner';
  END IF;
END $$;

INSERT INTO test_catalog.listings
  (bot_id, owner_id, external_id, title, source_url, price_rub,
   details, reference_size_charts, source_assets, captured_on)
VALUES
  (8785889729, 'telegram:264147129', '8196709817',
   'Джинсы широкие темные Zara type Jeans',
   'https://www.avito.ru/moskva/odezhda_obuv_aksessuary/dzhinsy_shirokie_temnye_zara_type_jeans_8196709817',
   2349,
   '{"seller":"Gabigabicom","location":"Moscow","condition":"new_with_tags","brand_field":"Zara","authenticity_verified":false,"material":"denim","composition_percentages":null,"color":"black","fit":"wide straight","description":"Black patterned jeans with a basic wide straight fit. Suitable for different body types.","season":"any","size_field":"48 (M)","advertised_sizes":["XS","S","M","L","XL","XXL"],"size_aliases":{"XXL":"2XL"},"availability_label":"several","exact_source_stock":null,"shipping":"Avito delivery","dispatch_within_hours":24,"try_on":true,"returns_days":14,"size_selection_inputs":["height","weight"],"seller_claims_photos_are_original":true,"facts_are_snapshot":true}'::jsonb,
   '{}'::jsonb,
   '{"listing_screenshot":"/Users/antonkaprielov/Downloads/screencapture-avito-ru-moskva-odezhda-obuv-aksessuary-dzhinsy-shirokie-temnye-zara-type-jeans-8196709817-2026-10-25-12_57_24.png","size_chart":"/Users/antonkaprielov/Downloads/Telegram Desktop/photo_2026-10-25_13-14-59.jpg","product_photo_files":[]}'::jsonb,
   '2026-10-25'),
  (8785889729, 'telegram:264147129', '8228360596',
   'Джинсы клеш Flared Type Levi’s 512 буткат type',
   'https://www.avito.ru/moskva/odezhda_obuv_aksessuary/dzhinsy_klesh_flared_type_levis_512_butkat_type_8228360596',
   2390,
   '{"seller":"Gabigabicom","location":"Moscow","condition":"new_with_tags","brand_field":"unbranded","title_style_reference":"Levi’s 512 type","authenticity_verified":false,"material":"denim","composition_percentages":null,"color":"black","description_color":"black / dark gray","fit":"slightly flared bootcut","description":"Distressed jeans with a raw fringed hem and slight flare.","size_field":"48 (M)","advertised_size_range":"XS through X-LARGE","chart_sizes":["XS","S","M","L","XL","2XL"],"chart_size_not_advertised":["2XL"],"availability_label":"several","exact_source_stock":null,"shipping":"Avito delivery","dispatch_within_hours":24,"dispatch_delay_note":"Pickup point operating hours may cause delays.","recommended_pickup_providers":["Yandex","Avito","CDEK","5Post"],"try_on":true,"returns_days":14,"size_selection_inputs":["height","weight"],"seller_claims_photos_are_original":true,"measurement_tolerance_cm":2,"chart_note":"Light color runs approximately one size smaller than black. Refer to measurements.","facts_are_snapshot":true}'::jsonb,
   '{"light":{"reference_only":true,"availability_confirmed":false,"rows":[{"size":"XS","half_waist":34,"length":104,"half_hips":47,"leg_opening_width":26},{"size":"S","half_waist":36,"length":107,"half_hips":49,"leg_opening_width":27},{"size":"M","half_waist":37,"length":108,"half_hips":51,"leg_opening_width":27},{"size":"L","half_waist":40,"length":109,"half_hips":53,"leg_opening_width":29},{"size":"XL","half_waist":42,"length":111,"half_hips":55,"leg_opening_width":30},{"size":"2XL","half_waist_min":44,"half_waist_max":45,"length":114,"half_hips":58,"leg_opening_width":31}],"units":"cm"}}'::jsonb,
   '{"listing_screenshot":"/Users/antonkaprielov/Downloads/screencapture-avito-ru-moskva-odezhda-obuv-aksessuary-dzhinsy-klesh-flared-type-levis-512-butkat-type-8228360596-2026-10-25-12_53_29.png","size_chart":"/Users/antonkaprielov/Downloads/Telegram Desktop/photo_2026-10-25_13-15-34.jpg","product_photo_files":[]}'::jsonb,
   '2026-10-25')
ON CONFLICT (bot_id, external_id) DO NOTHING;

INSERT INTO test_catalog.listing_variants
  (bot_id, external_id, color, size, stock, measurements_cm)
SELECT 8785889729, external_id, 'black', size,
       floor(random() * 6)::integer, measurements_cm
FROM (VALUES
  ('8196709817', 'XS', '{"half_waist":36,"length":110,"leg_opening_width":28}'::jsonb),
  ('8196709817', 'S', '{"half_waist":38,"length":110,"leg_opening_width":29}'::jsonb),
  ('8196709817', 'M', '{"half_waist":40,"length":111,"leg_opening_width":30}'::jsonb),
  ('8196709817', 'L', '{"half_waist":42,"length":112,"leg_opening_width":31}'::jsonb),
  ('8196709817', 'XL', '{"half_waist":44,"length":113,"leg_opening_width":31}'::jsonb),
  ('8196709817', '2XL', '{"half_waist":46,"length":115,"leg_opening_width":32}'::jsonb),
  ('8228360596', 'XS', '{"half_waist":36,"length":105,"half_hips":47,"leg_opening_width":26}'::jsonb),
  ('8228360596', 'S', '{"half_waist":38,"length":107,"half_hips":49,"leg_opening_width":27}'::jsonb),
  ('8228360596', 'M', '{"half_waist":40,"length":108,"half_hips":51,"leg_opening_width":27}'::jsonb),
  ('8228360596', 'L', '{"half_waist":42,"length":109,"half_hips":53,"leg_opening_width":29}'::jsonb),
  ('8228360596', 'XL', '{"half_waist":44,"length":111,"half_hips":55,"leg_opening_width":30}'::jsonb),
  ('8228360596', '2XL', '{"half_waist_min":45,"half_waist_max":46,"length":114,"half_hips":58,"leg_opening_width":31}'::jsonb)
) AS sizes(external_id, size, measurements_cm)
ON CONFLICT (bot_id, external_id, color, size) DO NOTHING;

COMMIT;
