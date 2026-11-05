// Photos and files the user sends to the Assistant chat, turned into what the model can read.
// Photos go by link (GroupMe's image links are public), PDFs whole, Word documents and text files
// as text. Anything else is named so the assistant can ask for a PDF or a screenshot instead.

const MAX_BYTES = 15e6;

// GroupMe's file service, as worked out by github.com/beeper/groupme (pkg/groupmeext/message.go):
// POST /v1/<group>/fileData for the name and type, then POST /v1/<group>/files/<id> for the bytes.
async function groupmeFile(env, groupId, fileId) {
  const auth = { 'x-access-token': env.GROUPME_TOKEN };
  const base = `https://file.groupme.com/v1/${encodeURIComponent(groupId)}`;
  const meta = await fetch(`${base}/fileData`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ file_ids: [fileId] }) });
  if (!meta.ok) throw new Error(`GroupMe would not describe the file (${meta.status})`);
  const m = (await meta.json())?.[0]?.file_data;
  if (!m?.file_name) throw new Error('GroupMe sent no file details');
  if (m.file_size > MAX_BYTES) throw new Error('the file is over 15 MB');
  const r = await fetch(`${base}/files/${encodeURIComponent(fileId)}`, { method: 'POST', headers: auth });
  if (!r.ok) throw new Error(`GroupMe would not hand over the file (${r.status})`);
  return { name: m.file_name, type: m.mime_type || '', bytes: new Uint8Array(await r.arrayBuffer()) };
}

const base64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// One file out of a .zip (Word, PowerPoint and Excel files are zips): read from the central directory.
export async function zipEntry(bytes, wanted) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && dv.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) return null;
  let p = dv.getUint32(end + 16, true);
  for (let i = dv.getUint16(end + 10, true); i > 0; i--) {
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const local = dv.getUint32(p + 42, true);
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return new TextDecoder().decode(data);
      return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    }
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return null;
}

// The words of a Word document, one paragraph a line.
export async function docxText(bytes) {
  const xml = await zipEntry(bytes, 'word/document.xml');
  if (xml == null) return null;
  return xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// A downloaded file -> a message part for the model, or a text note saying why it can't be read.
export async function filePart({ name, type, bytes }) {
  const lower = name.toLowerCase();
  if (type === 'application/pdf' || lower.endsWith('.pdf')) {
    return { type: 'file', file: { filename: name, file_data: `data:application/pdf;base64,${base64(bytes)}` } };
  }
  if (type.startsWith('image/')) return { type: 'image_url', image_url: { url: `data:${type};base64,${base64(bytes)}` } };
  if (lower.endsWith('.docx')) {
    const text = await docxText(bytes);
    if (text != null) return { type: 'text', text: `[Word document "${name}"]\n${text.slice(0, 40000)}` };
  }
  if (type.startsWith('text/') || /\.(txt|csv|md|json|ics)$/.test(lower)) {
    return { type: 'text', text: `[file "${name}"]\n${new TextDecoder().decode(bytes).slice(0, 40000)}` };
  }
  return { type: 'text', text: `[They sent "${name}", a kind of file you can't open. Ask them for a PDF or a screenshot instead.]` };
}

// A photo by its link, downloaded here so the model never has to fetch it itself.
export async function imagePart(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'dottie-ai-assistant/1.0' } });
  if (!r.ok) throw new Error(`the photo would not download (${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('the photo is over 15 MB');
  return filePart({ name: 'photo', type: (r.headers.get('content-type') || 'image/jpeg').split(';')[0], bytes });
}

// Everything attached to one of the user's messages. `note` is what goes into the saved chat history,
// since the file itself is only seen in this one turn.
export async function attachmentParts(env, groupId, attachments = []) {
  const parts = [];
  const notes = [];
  for (const a of attachments.slice(0, 5)) {
    try {
      if (a.type === 'image' && a.url) {
        parts.push(await imagePart(a.url));
        notes.push('[sent a photo]');
      } else if (a.type === 'file' && a.file_id) {
        const f = await groupmeFile(env, groupId, a.file_id);
        parts.push(await filePart(f));
        notes.push(`[sent a file: ${f.name}]`);
      } else if (a.type === 'video') {
        if (a.preview_url) parts.push(await imagePart(a.preview_url));
        parts.push({ type: 'text', text: "[They sent a video. You can only see its preview picture; say so if it matters.]" });
        notes.push('[sent a video]');
      }
    } catch (e) {
      parts.push({ type: 'text', text: `[They sent a file you couldn't open (${e.message}). Ask them to send it as a PDF or a screenshot.]` });
      notes.push('[sent a file that could not be opened]');
    }
  }
  return { parts, note: notes.join(' ') };
}
