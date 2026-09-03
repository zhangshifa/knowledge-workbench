#!/usr/bin/env node
// 把仓库根目录的 web/ 同步到 Capacitor 的 webDir（mobile/public）。
// 这样 APK 内嵌的就是同一份前端代码，无需重复维护。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'web');
const DEST = path.join(ROOT, 'mobile', 'public');

if (!fs.existsSync(SRC)) {
  console.error(`找不到源目录：${SRC}`);
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

let count = 0;
function copyDir(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
      count++;
      console.log('  +', path.relative(ROOT, d));
    }
  }
}

copyDir(SRC, DEST);
console.log(`\n已同步 ${count} 个文件到 mobile/public`);
