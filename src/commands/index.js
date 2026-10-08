// コマンドの登録と振り分け
import { REST, Routes, Events } from 'discord.js';
import { client } from '../client.js';
import { DISCORD_TOKEN, GUILD_ID } from '../config.js';
import { EPHEMERAL } from '../util.js';
import { handleAttendanceButton } from '../features/events.js';
import * as general from './general.js';
import * as reminders from './reminders.js';
import * as calendarCmds from './calendar.js';
import * as members from './members.js';
import * as saylater from './saylater.js';
import * as goodjob from './goodjob.js';
import * as state from './state.js';

const modules = [general, reminders, calendarCmds, members, saylater, goodjob, state];
const allCommands = modules.flatMap(m => m.commands);

// ボタン・モーダルの customId の先頭（"att:..." の "att"）→ ハンドラ
const componentHandlers = {
  att: handleAttendanceButton,
  ...Object.assign({}, ...modules.map(m => m.components ?? {})),
};

const commandMap = new Map();

// ctx: 起動時にしか決まらない情報（GIFカテゴリなど）
export async function registerCommands(ctx) {
  commandMap.clear();
  const body = [];
  for (const cmd of allCommands) {
    const data = typeof cmd.data === 'function' ? cmd.data(ctx) : cmd.data;
    commandMap.set(data.name, cmd);
    body.push(data.toJSON());
  }
  await new REST({ version: '10' }).setToken(DISCORD_TOKEN)
    .put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body });
  console.log(`✅ Slash commands registered (${body.length})`);
}

// 起動直後（コマンド登録前）でも動けるよう、名前で引けるようにしておく
for (const cmd of allCommands) {
  const data = typeof cmd.data === 'function' ? null : cmd.data;
  if (data) commandMap.set(data.name, cmd);
}

async function replyError(interaction, e) {
  // 10062 = Unknown interaction（3秒以内に応答できなかった）
  if (e?.code === 10062) {
    console.warn(`⚠️ インタラクション期限切れ: ${interaction.commandName ?? interaction.customId}`);
    return;
  }
  console.error(`❌ インタラクションエラー (${interaction.commandName ?? interaction.customId}):`, e);
  const content = `❌ エラーが発生しました: ${e?.message ?? e}`;
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: EPHEMERAL });
    else await interaction.reply({ content, flags: EPHEMERAL });
  } catch {}
}

export function registerInteractionHandler() {
  client.on(Events.InteractionCreate, async interaction => {
    try {
      if (interaction.isAutocomplete()) {
        const cmd = commandMap.get(interaction.commandName);
        if (cmd?.autocomplete) await cmd.autocomplete(interaction);
        return;
      }
      if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
        const cmd = commandMap.get(interaction.commandName);
        if (!cmd) return interaction.reply({ content: '⚠️ 不明なコマンドです', flags: EPHEMERAL });
        await cmd.execute(interaction);
        return;
      }
      if (interaction.isButton() || interaction.isModalSubmit()) {
        const handler = componentHandlers[interaction.customId.split(':')[0]];
        if (handler) await handler(interaction);
      }
    } catch (e) {
      if (!interaction.isAutocomplete()) await replyError(interaction, e);
    }
  });
}
