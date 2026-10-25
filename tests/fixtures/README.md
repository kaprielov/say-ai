# Document upload fixtures

`knowledge.doc` and `knowledge.docx` are synthetic English documents generated from
`knowledge.html`. Regenerate them on macOS with:

```sh
textutil -convert doc -output tests/fixtures/knowledge.doc tests/fixtures/knowledge.html
textutil -convert docx -output tests/fixtures/knowledge.docx tests/fixtures/knowledge.html
```

Tests read these committed files directly and do not require macOS or Microsoft Word.

## Image knowledge fixtures

`images/size-chart.svg` is the synthetic source for the committed PNG/JPEG/WebP
size chart. `images/ground-truth.json` is its manually transcribed reference, not
provider output. The chart deliberately distinguishes body measurements, units,
and ranges. `held-out-chart.svg`/PNG uses a different product, numeric labels,
decimal values, inches, and garment measurements. Do not tune prompts against its
results and then describe it as held out.

Regenerate the base raster formats with the installed `sharp` package; for example:

```sh
node --input-type=module -e "import sharp from 'sharp'; await sharp('tests/fixtures/images/size-chart.svg').png().toFile('tests/fixtures/images/size-chart.png')"
```

The rotated chart is a 90-degree rotation of that PNG; the blurred chart applies
`sharp.blur(4)`. `instructions.png` contains an adversarial instruction and a
separate returns-policy fact. SVG is only a fixture-generation format and is not
accepted for uploads. Files are synthetic and contain no real customer data.

The deterministic tests use ground truth through controlled provider transports.
They verify persistence, context, and contracts, not vision quality. The separate
opt-in `live image extraction and grounded size-chart answers` test in
`tests/image-sources.test.mjs` uses real recognition, embeddings, retrieval and
answers for the baseline, held-out, and rotated chart (including a Russian question).
It requires explicit authorization, `RUN_LIVE_IMAGE_TEST=true`, and a funded API key.
Blurred-cell behavior and image instructions additionally require manual semantic
review; their fixtures are supplied but no quality result is claimed.
