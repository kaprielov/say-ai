# Document upload fixtures

`knowledge.doc` and `knowledge.docx` are synthetic English documents generated from
`knowledge.html`. Regenerate them on macOS with:

```sh
textutil -convert doc -output tests/fixtures/knowledge.doc tests/fixtures/knowledge.html
textutil -convert docx -output tests/fixtures/knowledge.docx tests/fixtures/knowledge.html
```

Tests read these committed files directly and do not require macOS or Microsoft Word.
