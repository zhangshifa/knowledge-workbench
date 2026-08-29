import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALG = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;

let cachedKey = null;

/**
 * 取得主密钥。
 * 优先使用环境变量 KB_MASTER_KEY；否则在数据目录生成并复用一个随机密钥文件。
 */
export function getMasterKey(dataDir) {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.KB_MASTER_KEY;
  if (fromEnv && fromEnv.length > 0) {
    cachedKey = crypto.scryptSync(fromEnv, 'knowledge-workbench/v1', KEY_LEN);
    return cachedKey;
  }
  const keyFile = path.join(dataDir, '.master-key');
  let raw;
  if (fs.existsSync(keyFile)) {
    raw = fs.readFileSync(keyFile, 'utf8').trim();
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    raw = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, raw, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(keyFile, 0o600);
    } catch {
      /* Windows 上 chmod 可能不生效，忽略 */
    }
  }
  cachedKey = crypto.scryptSync(raw, 'knowledge-workbench/v1', KEY_LEN);
  return cachedKey;
}

/** AES-256-GCM 加密，输出 base64(iv|tag|ciphertext) */
export function encrypt(plain, dataDir) {
  if (plain === undefined || plain === null || plain === '') return '';
  const key = getMasterKey(dataDir);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** 解密；失败时抛出明确错误（通常是换机器后密钥文件丢失） */
export function decrypt(payload, dataDir) {
  if (!payload) return '';
  const buf = Buffer.from(String(payload), 'base64');
  if (buf.length <= IV_LEN + 16) {
    throw new Error('凭证密文格式非法');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + 16);
  const enc = buf.subarray(IV_LEN + 16);
  const key = getMasterKey(dataDir);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('凭证解密失败：主密钥与加密时不一致（请检查 KB_MASTER_KEY 或 data/.master-key）');
  }
}
