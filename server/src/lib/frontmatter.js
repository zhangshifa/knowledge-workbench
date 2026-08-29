/**
 * 解析 Markdown 文件的 YAML front matter（够用版：仅支持 key: value 与 [a, b] 列表）。
 * 解析失败不抛错，原样返回正文。
 */
export function parseFrontMatter(md) {
  const text = String(md || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };

  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z0-9_\-.]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v
        .slice(1, -1)
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, '');
    }
    data[kv[1]] = v;
  }
  return { data, body: text.slice(m[0].length) };
}

/** 从 Markdown 正文中取第一个一级标题作为标题 */
export function firstHeading(md, fallback = '') {
  const m = /^\s*#\s+(.+)$/m.exec(String(md || ''));
  if (m) return m[1].trim().replace(/#+\s*$/, '').trim();
  return fallback;
}

export function firstParagraph(md) {
  const m = /^(?!#|\s*[-*+>]|\s*```)(.+\S.*)$/m.exec(String(md || ''));
  return m ? m[1].trim() : '';
}
