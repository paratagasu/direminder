// 自動バックアップ
// 保存先（BACKUP_USER_ID のユーザーへのDM、または BACKUP_CHANNEL_ID のチャンネル）に
// 「1件のメッセージ」を置き、それを上書き編集し続ける。
// ・メッセージの編集は通知も未読マークも付かないので迷惑がかからない
// ・最初の1回だけ投稿するが、@silent（通知なし）で送る
// ・BACKUP_ENCRYPTION_KEY を設定すると AES-256-GCM で暗号化する（鍵が無いと中身は読めない）
// 起動時はそのメッセージの添付ファイルから状態を復元する。
import crypto from 'node:crypto';
import { AttachmentBuilder, MessageFlags } from 'discord.js';
import { client } from './client.js';
import { db, onDbWrite } from './db.js';
import { BACKUP_USER_ID, BACKUP_CHANNEL_ID, BACKUP_ENCRYPTION_KEY } from './config.js';
import { buildStateExport, applyState } from './state.js';
import { formatJst } from './time.js';

const FILE_NAME = 'bot-state-backup.json';
const DEBOUNCE_MS = Number(process.env.BACKUP_DEBOUNCE_MS) || 30 * 1000;

// ============================================================
// 暗号化（AES-256-GCM。鍵は BACKUP_ENCRYPTION_KEY から scrypt で導出）
// ============================================================
function deriveKey(salt) {
  return crypto.scryptSync(BACKUP_ENCRYPTION_KEY, salt, 32);
}

export function encryptState(text) {
  if (!BACKUP_ENCRYPTION_KEY) return text;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  const data = Buffer.concat([cipher.update(text, 'utf-8'), cipher.final()]);
  return JSON.stringify({
    encrypted: 'aes-256-gcm',
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  });
}

export function decryptState(text) {
  const json = JSON.parse(text);
  if (!json.encrypted) return json; // 暗号化されていないバックアップ
  if (!BACKUP_ENCRYPTION_KEY) throw new Error('バックアップは暗号化されていますが BACKUP_ENCRYPTION_KEY が未設定です');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(Buffer.from(json.salt, 'base64')), Buffer.from(json.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(json.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(json.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf-8'));
  } catch {
    throw new Error('バックアップを復号できません（BACKUP_ENCRYPTION_KEY が違う可能性があります）');
  }
}

// 保存先（DMを優先）
const TARGET_LABEL = BACKUP_USER_ID ? `<@${BACKUP_USER_ID}> へのDM` : BACKUP_CHANNEL_ID ? `<#${BACKUP_CHANNEL_ID}>` : null;
async function getBackupChannel() {
  if (BACKUP_USER_ID) {
    const user = await client.users.fetch(BACKUP_USER_ID);
    return user.createDM();
  }
  return client.channels.fetch(BACKUP_CHANNEL_ID);
}

export const backupStatus = {
  configured: !!(BACKUP_USER_ID || BACKUP_CHANNEL_ID),
  target: TARGET_LABEL,
  encrypted: !!BACKUP_ENCRYPTION_KEY,
  enabled: false,        // 復元処理が終わるまでは false（空の状態で上書きしないため）
  lastBackupAt: null,
  lastError: null,
  restoreResult: null,
};
let timer = null;
let messageId = null;
let lastFingerprint = null;
let running = Promise.resolve();

onDbWrite(() => {
  if (!backupStatus.configured || !backupStatus.enabled || timer) return;
  timer = setTimeout(() => { timer = null; runBackup().catch(() => {}); }, DEBOUNCE_MS);
});

export function isBackupMessage(m) {
  return m.author?.id === client.user.id && m.attachments?.some(a => a.name === FILE_NAME);
}

// 他のBotのテストなどでメッセージが流れても見つけられるよう、さかのぼって探す
const SEARCH_LIMIT = 2000;
async function findBackupMessage(channel) {
  if (messageId) {
    const m = await channel.messages.fetch(messageId).catch(() => null);
    if (m) return m;
  }
  let before;
  for (let searched = 0; searched < SEARCH_LIMIT; searched += 100) {
    const msgs = await channel.messages.fetch({ limit: 100, ...(before && { before }) });
    const found = msgs.find(isBackupMessage);
    if (found) return found;
    if (msgs.size < 100) break;
    before = msgs.last().id;
  }
  return null;
}

// バックアップを実行（同時実行しないよう直列化）
export function runBackup({ force = false } = {}) {
  const p = running.then(() => doBackup(force));
  running = p.catch(() => {}); // 失敗しても次のバックアップは実行できるようにする
  return p.catch(e => {
    backupStatus.lastError = e.message;
    console.error('❌ 自動バックアップ失敗:', e.message);
    throw e;
  });
}

async function doBackup(force) {
  if (!backupStatus.configured) throw new Error('BACKUP_USER_ID / BACKUP_CHANNEL_ID が未設定です');
  const state = buildStateExport();
  // 内容が変わっていなければ何もしない（保存時刻だけの変化は無視）
  const fingerprint = JSON.stringify({ ...state, exportedAt: null, savedAt: null });
  if (!force && fingerprint === lastFingerprint) return;

  const channel = await getBackupChannel();
  const file = new AttachmentBuilder(Buffer.from(encryptState(JSON.stringify(state)), 'utf-8'), { name: FILE_NAME });
  const content = `🗄️ Botの自動バックアップです${BACKUP_ENCRYPTION_KEY ? '（暗号化済み）' : ''}（自動で上書き更新されます。削除しないでください）\n最終更新: ${formatJst(new Date())}`;
  let msg = await findBackupMessage(channel);
  if (msg) {
    await msg.edit({ content, files: [file], attachments: [] });
  } else {
    msg = await channel.send({ content, files: [file], flags: MessageFlags.SuppressNotifications });
  }
  messageId = msg.id;
  lastFingerprint = fingerprint;
  backupStatus.lastBackupAt = new Date().toISOString();
  backupStatus.lastError = null;
  console.log('🗄️ 自動バックアップ完了');
}

// 起動時の復元。バックアップの方が新しければ取り込む
export async function restoreFromBackup() {
  if (!backupStatus.configured) {
    backupStatus.restoreResult = '未設定（BACKUP_USER_ID / BACKUP_CHANNEL_ID なし）';
    return { status: 'disabled' };
  }
  try {
    const channel = await getBackupChannel();
    const msg = await findBackupMessage(channel);
    if (!msg) {
      backupStatus.enabled = true;
      backupStatus.restoreResult = 'バックアップなし（新規作成します）';
      runBackup({ force: true }).catch(() => {});
      return { status: 'none' };
    }
    messageId = msg.id;
    const att = msg.attachments.find(a => a.name === FILE_NAME);
    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`バックアップの取得に失敗 (${res.status})`);
    const json = decryptState(await res.text());

    const localSavedAt  = db.data.savedAt ? Date.parse(db.data.savedAt) : 0;
    const backupSavedAt = json.savedAt ? Date.parse(json.savedAt) : Date.parse(json.exportedAt);
    if (localSavedAt > backupSavedAt) {
      backupStatus.enabled = true;
      backupStatus.restoreResult = 'ローカルの状態の方が新しいため復元せず';
      runBackup({ force: true }).catch(() => {});
      return { status: 'skipped' };
    }
    await applyState(json);
    backupStatus.enabled = true;
    backupStatus.restoreResult = `復元しました（${formatJst(backupSavedAt)} 時点）`;
    console.log(`🗄️ バックアップから復元: ${formatJst(backupSavedAt)} 時点`);
    return { status: 'restored', savedAt: backupSavedAt };
  } catch (e) {
    // 復元に失敗したときは、正しいバックアップを空の状態で上書きしないよう自動バックアップを止めておく
    backupStatus.lastError = e.message;
    backupStatus.restoreResult = `復元失敗: ${e.message}（上書きしないよう自動バックアップを停止中。/state-import で手動復元するか、/backup-now で今の状態から再開）`;
    console.error('❌ バックアップからの復元失敗:', e.message);
    return { status: 'error', error: e };
  }
}

export function enableBackup() { if (backupStatus.configured) backupStatus.enabled = true; }

// 終了時（Koyebの再デプロイ時など）に未保存の変更を書き出す
export async function flushBackup() {
  if (!backupStatus.enabled) return;
  if (timer) { clearTimeout(timer); timer = null; }
  await runBackup().catch(() => {});
}
