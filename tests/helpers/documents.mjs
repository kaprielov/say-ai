import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

export function wordFixture(extension) {
  return readFile(new URL(`../fixtures/knowledge.${extension}`, import.meta.url));
}

export async function docxFixture(text) {
  const zip = await JSZip.loadAsync(await wordFixture('docx'));
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:p><w:r><w:t>${escaped}</w:t></w:r></w:p></w:body>
    </w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Build a small PDF with real page objects, text streams, and byte offsets.
export function pdfFixture(pages = ['Our shop closes at 10 PM.', 'Delivery takes two days.']) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const text of pages) {
    const escaped = text.replace(/[\\()]/g, '\\$&');
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
