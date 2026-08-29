/**
 * 解析 Evernote 导出文件（.enex）。
 * ENEX 是包裹在 <en-export> 里的若干 <note>，正文为 <en-note> HTML（CDATA）。
 */

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function cdata(m) {
  if (!m) return '';
  return decodeEntities(m.replace(/^<!\[CDATA\[|\]\]>$/g, ''));
}

/** 将 Evernote 时间戳 20260829T120000Z 转为 ISO */
function toISO(s) {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s.trim());
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
}

export function parseEnex(text) {
  const xml = String(text || '');
  const notes = [];
  const noteRe = /<note>([\s\S]*?)<\/note>/g;
  let m;
  while ((m = noteRe.exec(xml))) {
    const block = m[1];

    const titleM = /<title>([\s\S]*?)<\/title>/.exec(block);
    const contentM = /<content>([\s\S]*?)<\/content>/.exec(block);
    const createdM = /<created>([\s\S]*?)<\/created>/.exec(block);
    const updatedM = /<updated>([\s\S]*?)<\/updated>/.exec(block);
    const tagMs = Array.from(block.matchAll(/<tag>([\s\S]*?)<\/tag>/g)).map((x) => decodeEntities(x[1]).trim());
    const notebookM = /<notebook>([\s\S]*?)<\/notebook>/.exec(block);

    const enNote = /<en-note[^>]*>([\s\S]*?)<\/en-note>/.exec(cdata(contentM?.[1]) || '');
    const html = enNote ? enNote[1] : cdata(contentM?.[1]) || '';

    notes.push({
      title: decodeEntities(titleM?.[1] || '(无标题)').trim(),
      html,
      created: toISO(createdM?.[1]),
      updated: toISO(updatedM?.[1]),
      tags: tagMs.filter(Boolean),
      notebook: notebookM ? decodeEntities(notebookM[1]) : ''
    });
  }
  return notes;
}

export function parseEnexList(text) {
  return parseEnex(text);
}
