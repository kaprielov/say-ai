// Keep document parsers outside the API process so malformed files cannot block requests.
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const buffer = Buffer.concat(chunks);

try {
  let text: string;
  switch (process.argv[2]) {
    case '.pdf': {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer, verbosity: 0, isEvalSupported: false });
      try {
        const result = await parser.getText({ pageJoiner: '\n\n' });
        text = result.text;
      } finally {
        await parser.destroy();
      }
      break;
    }
    case '.docx': {
      const mammoth = await import('mammoth');
      text = (await mammoth.extractRawText({ buffer })).value;
      break;
    }
    case '.doc': {
      const { default: WordExtractor } = await import('word-extractor');
      const document = await new WordExtractor().extract(buffer);
      text = [document.getBody(), document.getFootnotes(), document.getEndnotes(), document.getTextboxes()].filter(Boolean).join('\n\n');
      break;
    }
    default:
      throw new Error('Unsupported document format.');
  }
  process.stdout.write(text);
} catch {
  // Never expose parser diagnostics, paths, or source content to the caller.
  process.exitCode = 1;
}
