import { readZip } from './zip.js';
import { htmlToText } from './normalize.js';

/** docx → 纯文本。段落、换行、制表符保留，表格按行折叠。 */
export function docxToText(buffer) {
  const zip = readZip(buffer);
  const xml = zip.readText('word/document.xml');
  if (!xml) return '';

  let text = xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ')
    .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_m, t) => decodeXmlEntities(t))
    .replace(/<[^>]+>/g, '');

  return decodeXmlEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** xlsx → 纯文本（取共享字符串 + 第一张工作表，够用于知识检索） */
export function xlsxToText(buffer) {
  const zip = readZip(buffer);
  const shared = [];
  const ssXml = zip.readText('xl/sharedStrings.xml');
  if (ssXml) {
    for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const cells = Array.from(m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)).map((x) =>
        decodeXmlEntities(x[1])
      );
      shared.push(cells.join(''));
    }
  }

  const sheetName =
    zip.names().find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n)) ||
    zip.names().find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
  if (!sheetName) return shared.join('\n');

  const sheet = zip.readText(sheetName);
  const rows = [];
  for (const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of r[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = c[1] || c[3] || '';
      const inner = c[2] || '';
      const tAttr = /t="([^"]+)"/.exec(attrs);
      const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
      const isText = /<is>/.test(inner);
      if (isText) {
        const inline = Array.from(inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
          .map((x) => decodeXmlEntities(x[1]))
          .join('');
        cells.push(inline);
      } else if (vMatch) {
        const v = decodeXmlEntities(vMatch[1]);
        cells.push(tAttr && tAttr[1] === 's' ? shared[Number(v)] ?? v : v);
      } else {
        cells.push('');
      }
    }
    if (cells.some((x) => String(x).trim())) rows.push(cells.join(' | '));
  }
  return rows.join('\n').trim();
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** 根据扩展名把常见办公文件转成文本 */
export function officeToText(ext, buffer) {
  const e = String(ext || '').toLowerCase();
  if (e === '.docx') return docxToText(buffer);
  if (e === '.xlsx') return xlsxToText(buffer);
  if (e === '.html' || e === '.htm') return htmlToText(buffer.toString('utf8'));
  return buffer.toString('utf8');
}
