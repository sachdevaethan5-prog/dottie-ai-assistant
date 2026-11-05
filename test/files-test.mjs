// Files the user sends: Word documents read from their zip, PDFs and photos passed on whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { docxText, filePart, zipEntry } from '../src/files.js';

// A real-shaped zip with the given entries (deflated), like a .docx.
function zip(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const n = enc.encode(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

test('a Word document becomes its text, one paragraph a line', async () => {
  const doc = zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Field trip: Fri Apr 16, 8am</w:t></w:r></w:p><w:p><w:r><w:t>Meet at the bus loop &amp; pack lunch</w:t></w:r></w:p></w:body></w:document>',
  });
  assert.equal(await zipEntry(doc, 'nope.xml'), null);
  assert.equal(await docxText(doc), 'Field trip: Fri Apr 16, 8am\nMeet at the bus loop & pack lunch');
  const part = await filePart({ name: 'Trip info.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: doc });
  assert.equal(part.type, 'text');
  assert.match(part.text, /^\[Word document "Trip info\.docx"\]\nField trip/);
});

test('PDFs and photos go to the model whole; unknown kinds ask for a PDF', async () => {
  const pdf = await filePart({ name: 'syllabus.pdf', type: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4') });
  assert.deepEqual(pdf, { type: 'file', file: { filename: 'syllabus.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjQ=' } });
  const img = await filePart({ name: 'flyer.png', type: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
  assert.equal(img.image_url.url, 'data:image/png;base64,AQID');
  const odd = await filePart({ name: 'deck.key', type: 'application/octet-stream', bytes: new Uint8Array([0]) });
  assert.match(odd.text, /can't open\. Ask them for a PDF or a screenshot/);
});
