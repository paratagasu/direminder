// メンバー表（Discordアカウント ↔ Googleカレンダー）
import { db } from './db.js';

export function getMembers() { return db.data.members ?? []; }

export function findMemberByDiscordId(userId) {
  return getMembers().find(m => m.discordIds?.includes(userId)) ?? null;
}

export function findMemberByName(name) {
  return getMembers().find(m => m.name === name) ?? null;
}

// 出欠の「未回答」判定などに使うメンバーのメインアカウント（先頭のID）
export function primaryIds() {
  return getMembers().map(m => m.discordIds?.[0]).filter(Boolean);
}

// 名前のオートコンプリート候補
export function memberNameChoices(focused = '') {
  return getMembers()
    .filter(m => m.name.includes(focused))
    .slice(0, 25)
    .map(m => ({ name: m.name, value: m.name }));
}
