require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionsBitField,
  MessageFlags,
  Partials,
} = require("discord.js");
const express = require("express");
const { Telegraf } = require("telegraf");

// ============================================================
// CONFIGURATION
// ============================================================
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ROLE_ID = process.env.ROLE_ID || "1547690932084936865";
const IMAGE_URL = process.env.IMAGE_URL;
const MOD_GUILD_ID = process.env.MOD_GUILD_ID || "1547685592928751628";
const MOD_CHANNEL_ID = process.env.MOD_CHANNEL_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "1548532310415118376";
const VALIDATED_CHANNEL_ID = process.env.VALIDATED_CHANNEL_ID || "1548532409153363968";
const FAILED_CHANNEL_ID = process.env.FAILED_CHANNEL_ID || "1548532447786967052";
const DB_STATS_CHANNEL_ID = process.env.DB_STATS_CHANNEL_ID || "1548535878509400184";
const ABSTRACT_API_KEY = process.env.ABSTRACT_API_KEY;
const VERIPHONE_API_KEY = process.env.VERIPHONE_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SITE_SECRET = process.env.SITE_SECRET;
const PORT = process.env.PORT || 3000;

// ============================================================
// EXPRESS (webhook + health)
// ============================================================
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("Bot online"));

// ===== SNAP+ CONFIG =====
const SNAP_SITE = "https://snap-reward.onrender.com";
const SNAP_MOD_CHANNEL_ID = process.env.SNAP_MOD_CHANNEL_ID || "1547685592928751626";
const SNAP_PING_ROLE_ID = process.env.SNAP_PING_ROLE_ID || "1547717348348403812";
const WEB_CLAIM_CHANNEL_ID = process.env.WEB_CLAIM_CHANNEL_ID || "1547685592928751628";

const treatedSnap = new Set();
const sentSnapCodes = new Set();
const webTickets = new Map();
const webhookDedup = new Map();

function snapFormatPhone(p) {
  return p.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
}

// Webhook : site web -> Discord embed
app.options("/webhook/form", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-secret-token");
  res.status(204).end();
});

app.post("/webhook/form", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-secret-token");

  if (req.headers["x-secret-token"] !== SITE_SECRET) {
    return res.status(401).json({ error: "Non autorise" });
  }

  const { pseudo, phone } = req.body || {};
  if (!pseudo || !phone) {
    return res.status(400).json({ error: "Pseudo et telephone requis" });
  }

  const dedupKey = `${pseudo}|${phone}`;
  const now = Date.now();
  const last = webhookDedup.get(dedupKey);
  if (last && now - last < 10000) {
    return res.status(429).json({ error: "Demande deja en cours de traitement" });
  }
  webhookDedup.set(dedupKey, now);

  try {
    const logChannel = await client.channels.fetch("1548532310415118376").catch(() => null);
    const modChannel = await getModChannel().catch(() => null);
    const targetChannel = modChannel || logChannel;
    if (!targetChannel) throw new Error("Aucun salon texte accessible par le bot");

    const modGuild = targetChannel.guild || (await client.guilds.fetch(MOD_GUILD_ID).catch(() => null));
    if (!modGuild) throw new Error("Guilde introuvable");

    const webId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const now2 = new Date();
    const dateStr = now2.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

    let claimChannel = await client.channels.fetch(WEB_CLAIM_CHANNEL_ID).catch(() => null);
    if (!claimChannel || !claimChannel.isTextBased()) {
      const guild = claimChannel && claimChannel.guild ? claimChannel.guild : modGuild;
      for (const [, ch] of guild.channels.cache) {
        if (ch.type === ChannelType.GuildText) {
          try {
            const perms = ch.permissionsFor(client.user);
            if (perms && perms.has([PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel])) {
              claimChannel = ch;
              break;
            }
          } catch {}
        }
      }
    }
    if (!claimChannel) throw new Error("Aucun salon textuel accessible pour envoyer le message Claim");

    const claimEmbed = new EmbedBuilder()
      .setTitle(pseudo)
      .setDescription(`Web · \`${webId}\`\n\n🟢 présent\n\n**Soumis** · ${dateStr}\n\nClaim par @_`)
      .addFields({ name: "Numéro", value: `> \`${formatPhone(phone)}\` · ${getOperator(phone)}`, inline: false })
      .setColor(0x2b2d31);

    const claimRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`claim_web_${webId}`).setLabel("✅ Claim — Créer le salon").setStyle(ButtonStyle.Primary)
    );

    const claimMsg = await claimChannel.send({
      content: `<@&1547717348348403812>`,
      embeds: [claimEmbed],
      components: [claimRow],
      allowedMentions: { roles: ["1547717348348403812"] },
    });

    webTickets.set(webId, {
      phone,
      originGuildId: "web",
      userId: "0",
      date: now,
      dateStr,
      modChannelId: claimChannel.id,
      modMessageId: claimMsg.id,
      claimedBy: null,
      threadId: null,
      detailMessageId: null,
      pseudo,
      tgName: null,
    });

    return res.json({ ok: true, webId });
  } catch (e) {
    console.error("Erreur webhook form:", e.message);
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Express] Serveur webhook sur le port ${PORT}`);
});

// ============================================================
// DISCORD CLIENT
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Etat
const pending = new Map();
const blacklistedNums = new Set();
const blacklistedUsers = new Set();
const PENDING_TIMEOUT_MS = 15 * 60 * 1000;

let tgBot = null;
if (TELEGRAM_BOT_TOKEN) {
  tgBot = new Telegraf(TELEGRAM_BOT_TOKEN);
  tgBot.launch().catch(() => console.warn("[Telegram] Impossible de demarrer le bot Telegram"));
}

let stats = {
  validated: 1,
  failed: 5,
  lastUpdate: "2026-09-13T03:06:15Z",
  lastUpdateBy: "1536783268219977738",
  lastStatus: "validated",
  staff: {
    "1536783268219977738": {
      validated: 1,
      failed: 5,
      lastUpdate: "2026-09-13T03:06:15Z",
      lastStatus: "validated",
      tag: "Staff",
    },
  },
  telegramUsers: {},
  blacklistedNums: [],
  blacklistedUsers: [],
  pending: {},
};
let dbStatsMessageId = null;
let readyDone = false;

const STATS_PATH = path.join(__dirname, "stats.json");

// ============================================================
// FONCTIONS UTILITAIRES
// ============================================================
function formatPhone(p) {
  return p.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
}

function getOperatorSync(p) {
  const pre = p.slice(0, 4);
  const bouygues = new Set([
    "0653","0660","0661","0662","0663","0664","0665","0666","0667","0668","0695","0696","0697","0698","0699",
    "0760","0761","0762","0763","0798","0799",
  ]);
  const free = new Set(["0651","0652","0654","0656","0749","0750","0768","0769","0783","0784"]);
  const orange = new Set([
    "0607","0608","0630","0631","0632","0633","0634","0635","0670","0671","0672","0673","0674","0675","0676",
    "0677","0678","0679","0680","0681","0682","0683","0684","0685","0686","0687","0688","0689","0690","0707",
    "0764","0765","0766","0767","0770","0771","0776","0777","0780","0781","0782","0786","0787","0788","0789","0790",
  ]);
  const sfr = new Set([
    "0603","0604","0605","0606","0609","0610","0611","0612","0613","0614","0615","0616","0617","0618","0619",
    "0620","0621","0622","0623","0624","0625","0626","0627","0628","0629","0636","0639","0640","0641","0642",
    "0643","0644","0645","0646","0647","0648","0649","0650","0655","0657","0658","0659","0669","0691","0692",
    "0693","0694","0700","0701","0702","0703","0704","0705","0706","0708","0709",
  ]);
  if (bouygues.has(pre)) return "Bouygues Telecom";
  if (free.has(pre)) return "Free Mobile";
  if (orange.has(pre)) return "Orange";
  if (sfr.has(pre)) return "SFR Mobile";
  if (p.startsWith("06") || p.startsWith("07")) return "SFR Mobile";
  return "Mobile FR";
}

function getOperator(p) {
  return getOperatorSync(p);
}

const operatorCache = new Map();
async function getOperatorPrecise(p) {
  if (!p) return getOperatorSync(p);
  if (operatorCache.has(p)) return operatorCache.get(p);
  const key = ABSTRACT_API_KEY;
  if (!key) {
    const op = getOperatorSync(p);
    operatorCache.set(p, op);
    return op;
  }
  try {
    const phoneIntl = p.startsWith("0") ? "+33" + p.slice(1) : p;
    const url = `https://phonevalidation.abstractapi.com/v1/?api_key=${key}&phone=${encodeURIComponent(phoneIntl)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error("abstract status " + res.status);
    const j = await res.json();
    const carrier = j.carrier || j.carrier_name || j?.phone?.carrier;
    if (carrier && typeof carrier === "string" && carrier.trim()) {
      operatorCache.set(p, carrier.trim());
      return carrier.trim();
    }
  } catch (e) {
    const vKey = VERIPHONE_API_KEY;
    if (vKey) {
      try {
        const phoneIntl2 = p.startsWith("0") ? "+33" + p.slice(1) : p;
        const url2 = `https://api.veriphone.io/v2/verify?phone=${encodeURIComponent(phoneIntl2)}&key=${vKey}`;
        const res2 = await fetch(url2, { signal: AbortSignal.timeout(4000) });
        if (res2.ok) {
          const j2 = await res2.json();
          const carrier2 = j2.carrier || j2.carrier_name || j2?.carrier;
          if (carrier2 && typeof carrier2 === "string" && carrier2.trim()) {
            operatorCache.set(p, carrier2.trim());
            return carrier2.trim();
          }
        }
      } catch {}
    }
    const op = getOperatorSync(p);
    operatorCache.set(p, op);
    return op;
  }
  const vKey2 = VERIPHONE_API_KEY;
  if (vKey2) {
    try {
      const phoneIntl3 = p.startsWith("0") ? "+33" + p.slice(1) : p;
      const url3 = `https://api.veriphone.io/v2/verify?phone=${encodeURIComponent(phoneIntl3)}&key=${vKey2}`;
      const res3 = await fetch(url3, { signal: AbortSignal.timeout(4000) });
      if (res3.ok) {
        const j3 = await res3.json();
        const carrier3 = j3.carrier || j3.carrier_name || j3?.carrier;
        if (carrier3 && typeof carrier3 === "string" && carrier3.trim()) {
          operatorCache.set(p, carrier3.trim());
          return carrier3.trim();
        }
      }
    } catch {}
  }
  const op = getOperatorSync(p);
  operatorCache.set(p, op);
  return op;
}

function getOperatorSlug(p) {
  const op = getOperator(p);
  if (op.includes("Bouygues")) return "bouygues";
  if (op.includes("Free")) return "free";
  if (op.includes("Orange")) return "orange";
  if (op.includes("SFR")) return "sfr";
  return "mobile";
}

async function getOperatorSlugPrecise(p) {
  const op = await getOperatorPrecise(p);
  if (op.includes("Bouygues")) return "bouygues";
  if (op.includes("Free")) return "free";
  if (op.includes("Orange")) return "orange";
  if (op.includes("SFR")) return "sfr";
  return "mobile";
}

function saveStats() {
  try {
    fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
  } catch (e) {
    console.error("stats save fail:", e.message);
  }
}

async function getDbChannel() {
  try {
    return await client.channels.fetch(DB_STATS_CHANNEL_ID);
  } catch (e) {
    console.error("DB_STATS_CHANNEL fetch fail:", e.message);
    return null;
  }
}

async function loadDbStats() {
  const ch = await getDbChannel();
  if (!ch) return;
  try {
    const msgs = await ch.messages.fetch({ limit: 20 });
    const botMsg = msgs.find((m) => m.author.id === client.user.id && m.content.includes("DB_STATS"));
    if (botMsg) {
      dbStatsMessageId = botMsg.id;
      let jsonStr = "";
      if (botMsg.attachments.size > 0) {
        const att = botMsg.attachments.first();
        if (att && att.name === "stats.json") {
          try {
            const resp = await fetch(att.url);
            jsonStr = await resp.text();
          } catch {}
        }
      }
      if (!jsonStr) {
        jsonStr = botMsg.content.replace(/.*DB_STATS\s*/s, "").replace(/```json|```/g, "").trim();
      }
      const parsed = JSON.parse(jsonStr);
      stats = { ...stats, ...parsed };
      if (!stats.staff) stats.staff = {};
      if (!stats.telegramUsers) stats.telegramUsers = {};
      if (!stats.blacklistedNums) stats.blacklistedNums = [];
      if (!stats.blacklistedUsers) stats.blacklistedUsers = [];
      if (!stats.pending) stats.pending = {};
      blacklistedNums.clear();
      for (const n of stats.blacklistedNums) blacklistedNums.add(n);
      blacklistedUsers.clear();
      for (const u of stats.blacklistedUsers) blacklistedUsers.add(u);
      for (const [k, v] of Object.entries(stats.pending)) {
        if (k.startsWith("mass_")) continue;
        if (v.date) v.date = new Date(v.date);
        pending.set(k, v);
      }
      try {
        fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
      } catch {}
      console.log("[Stats] Chargees depuis db-stats");
      return;
    }
    const content = `DB_STATS\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\``;
    const sent = await ch.send(content);
    dbStatsMessageId = sent.id;
    console.log("[Stats] db-stats initial cree:", dbStatsMessageId);
  } catch (e) {
    console.error("loadDbStats fail:", e.message);
  }
}

function trackTelegramUser(tgUser, phone) {
  if (!stats.telegramUsers) stats.telegramUsers = {};
  const id = String(tgUser.id);
  stats.telegramUsers[id] = {
    username: tgUser.username || "",
    first_name: tgUser.first_name || "",
    lastSeen: new Date().toISOString(),
    phone: phone || stats.telegramUsers[id]?.phone || null,
  };
  saveDbStats().catch(() => {});
}

async function saveDbStats() {
  stats.blacklistedNums = [...blacklistedNums];
  stats.blacklistedUsers = [...blacklistedUsers];
  stats.pending = Object.fromEntries(
    [...pending.entries()]
      .filter(([k]) => !k.startsWith("mass_"))
      .map(([k, v]) => {
        const { timerInterval: _iv, ...rest } = v;
        return [k, { ...rest, date: v.date instanceof Date ? v.date.toISOString() : v.date }];
      })
  );
  saveStats();
  const ch = await getDbChannel();
  if (!ch) return;
  const jsonStr = JSON.stringify(stats);
  const content = `DB_STATS\n\`\`\`json\n${jsonStr}\n\`\`\``;
  const isTooLong = content.length > 1900;
  try {
    if (dbStatsMessageId) {
      const msg = await ch.messages.fetch(dbStatsMessageId).catch(() => null);
      if (msg) {
        if (isTooLong) {
          await msg.delete().catch(() => {});
          const sent = await ch.send({ content: "DB_STATS", files: [{ attachment: Buffer.from(jsonStr), name: "stats.json" }] });
          dbStatsMessageId = sent.id;
          return;
        }
        await msg.edit(content);
        return;
      }
    }
    const msgs = await ch.messages.fetch({ limit: 20 });
    const botMsg = msgs.find((m) => m.author.id === client.user.id && m.content.includes("DB_STATS"));
    if (botMsg) {
      dbStatsMessageId = botMsg.id;
      if (isTooLong) {
        await botMsg.delete().catch(() => {});
        const sent = await ch.send({ content: "DB_STATS", files: [{ attachment: Buffer.from(jsonStr), name: "stats.json" }] });
        dbStatsMessageId = sent.id;
      } else {
        await botMsg.edit(content);
      }
    } else {
      if (isTooLong) {
        const sent = await ch.send({ content: "DB_STATS", files: [{ attachment: Buffer.from(jsonStr), name: "stats.json" }] });
        dbStatsMessageId = sent.id;
      } else {
        const sent = await ch.send(content);
        dbStatsMessageId = sent.id;
      }
    }
  } catch (e) {
    console.error("saveDbStats fail:", e.message);
  }
}

function notifyTelegram(tgId, text, forceCode) {
  if (!tgBot) return;
  const extra = forceCode ? { reply_markup: { force_reply: true, input_field_placeholder: "0000" } } : undefined;
  tgBot.telegram.sendMessage(tgId, text, extra).catch(() => {});
}

async function getModChannel() {
  if (MOD_CHANNEL_ID) {
    try {
      const c = await client.channels.fetch(MOD_CHANNEL_ID);
      if (c) return c;
    } catch (e) {
      console.error("MOD_CHANNEL_ID fetch fail:", e.message);
    }
  }
  const guild = await client.guilds.fetch(MOD_GUILD_ID);
  const me = await guild.members.fetchMe().catch(() => null);
  const channels = await guild.channels.fetch();
  for (const [, ch] of channels) {
    if (ch.type !== ChannelType.GuildText) continue;
    try {
      const perms = me ? ch.permissionsFor(me) : ch.permissionsFor(guild.members.me);
      if (perms && perms.has([PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel])) return ch;
    } catch {}
  }
  throw new Error("Salon modo introuvable, mets MOD_CHANNEL_ID dans Render");
}

async function getLogChannel() {
  try {
    return await client.channels.fetch(LOG_CHANNEL_ID);
  } catch (e) {
    console.error("LOG_CHANNEL_ID fetch fail:", e.message);
    return null;
  }
}

async function sendClaimLog({ claimerId, claimedUserId, claimedUserTag, phone, originGuild, tgName }) {
  const logChannel = await getLogChannel();
  if (!logChannel) return;
  const operator = await getOperatorPrecise(phone);
  const formatted = formatPhone(phone);
  const nowStr = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const isTg = originGuild && originGuild.id === "tg";
  const embed = new EmbedBuilder()
    .setTitle("📌 Claim vérification")
    .setColor(0x5865f2)
    .setTimestamp()
    .addFields(
      { name: "👮 Claim par", value: `<@${claimerId}> \`${claimerId}\``, inline: false },
      { name: "👤 Claimé", value: isTg ? `${tgName || "Telegram"} \`${claimedUserId}\`` : `<@${claimedUserId}> \`${claimedUserId}\` ${claimedUserTag ? `(${claimedUserTag})` : ""}`, inline: false },
      { name: "📱 Numéro", value: `\`${formatted}\` · ${operator}`, inline: true },
      { name: "🌐 Origine", value: isTg ? "Telegram" : `${originGuild ? originGuild.name : "Inconnu"} \`${originGuild ? originGuild.id : "?"}\``, inline: true },
      { name: "📅 Date", value: nowStr, inline: false }
    )
    .setFooter({ text: `Claim • ${nowStr}` });
  try {
    await logChannel.send({ embeds: [embed] });
  } catch (e) {
    console.error("sendClaimLog fail:", e.message);
  }
}

async function sendFinalResultLog({ status, claimerId, claimedUserId, claimedUserTag, phone, originGuild, tgName }) {
  const targetId = status === "validated" ? VALIDATED_CHANNEL_ID : FAILED_CHANNEL_ID;
  let targetChannel = null;
  try {
    targetChannel = await client.channels.fetch(targetId);
  } catch (e) {
    console.error(`Final ${status} channel fetch fail:`, e.message);
    return;
  }
  const operator = phone ? await getOperatorPrecise(phone) : "Inconnu";
  const formatted = phone ? formatPhone(phone) : "Inconnu";
  const nowStr = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const isTg = originGuild && originGuild.id === "tg";
  const isValidated = status === "validated";
  const embed = new EmbedBuilder()
    .setTitle(isValidated ? "✅ Vérification validée" : "❌ Vérification échouée")
    .setColor(isValidated ? 0x57f287 : 0xed4245)
    .setTimestamp()
    .addFields(
      { name: "👮 Géré par", value: `<@${claimerId}> \`${claimerId}\``, inline: false },
      { name: "👤 Membre", value: isTg ? `${tgName || "Telegram"} \`${claimedUserId}\`` : (claimedUserId === "web" || !/^\d+$/.test(claimedUserId) ? `${claimedUserTag || claimedUserId}` : `<@${claimedUserId}> \`${claimedUserId}\` ${claimedUserTag ? `(${claimedUserTag})` : ""}`), inline: false },
      { name: "📱 Numéro", value: `\`${formatted}\` · ${operator}`, inline: true },
      { name: "🌐 Origine", value: isTg ? "Telegram" : `${originGuild ? originGuild.name : "Inconnu"} \`${originGuild ? originGuild.id : "?"}\``, inline: true },
      { name: "📅 Date", value: nowStr, inline: false }
    )
    .setFooter({ text: `${isValidated ? "Validé" : "Échoué"} • ${nowStr}` });
  try {
    await targetChannel.send({ embeds: [embed] });
  } catch (e) {
    console.error(`sendFinalResultLog ${status} fail:`, e.message);
  }
}

async function buildModEmbed(user, originGuild, phone, code, dateStr, claimTs = null, elapsedStr = null) {
  const operator = await getOperatorPrecise(phone);
  const formatted = formatPhone(phone);
  const codeLine = code ? `\`${code}\`` : "En attente du code membre";
  const timerLine = claimTs ? `> ⏱️ Timer — \`${elapsedStr || "00:00"}\` écoulé · <t:${claimTs}:R>` : "";
  const suivi = `> 🔄 Statut — ${code ? "Code reçu" : "SMS envoyé — en attente du code membre"}\n> 🌐 Code — ${codeLine}\n> 📅 Soumis — ${dateStr} · à l'instant\n> 📩 SMS envoyé — ${dateStr} · à l'instant${timerLine ? `\n${timerLine}` : ""}`;
  return new EmbedBuilder()
    .setTitle(`${user.username} • ${user.id}`)
    .setDescription(`${originGuild.name} • ${originGuild.memberCount || 0} membres`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: "Présence", value: `> 🟢 présent`, inline: false },
      { name: "Numéro", value: `> \`${formatted}\` · ${operator}`, inline: false },
      { name: "📋 Suivi vérification", value: suivi, inline: false }
    )
    .setColor(0x2b2d31);
}

function buildClaimEmbed(user, originGuild, memberPresent, memberCount, dateStr, claimedBy) {
  const presence = memberPresent ? "🟢 présent" : "❌ A quitté le serveur";
  const claimLine = claimedBy ? `<@${claimedBy}>` : "@_";
  return new EmbedBuilder()
    .setTitle(`${user.username}`)
    .setDescription(`<@${user.id}> · \`${user.id}\`\n${originGuild.name}\n\n${presence} · ${memberCount} membres\n\n**Soumis** · ${dateStr}\n\nClaim par ${claimLine}`)
    .setThumbnail(user.displayAvatarURL())
    .setColor(0x2b2d31);
}

function buildTimerEmbed(claimerId, claimTs, phone, operator) {
  const formatted = phone ? formatPhone(phone) : "Inconnu";
  return new EmbedBuilder()
    .setTitle("⏱️ Timer — Ticket en cours")
    .setDescription(`Claim par <@${claimerId}> • <t:${claimTs}:F> (<t:${claimTs}:R>)\nTraitement en cours…`)
    .addFields(
      { name: "⏳ Écoulé", value: "`00:00`", inline: true },
      { name: "⌛ Depuis claim", value: `<t:${claimTs}:R>`, inline: true },
      { name: "📞 Numéro", value: `> \`${formatted}\` · ${operator}`, inline: false }
    )
    .setColor(0x5865F2)
    .setFooter({ text: "Salon auto-supprimé après Oui / Non" })
    .setTimestamp(new Date(claimTs * 1000));
}

async function sendToMods(originInteraction, phone) {
  const user = originInteraction.user;
  const originGuild = originInteraction.guild;
  const key = `${originGuild.id}:${user.id}`;
  const now = new Date();
  const dateStr = now.toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  let present = true;
  try {
    await originGuild.members.fetch(user.id);
  } catch {
    present = false;
  }
  const embed = buildClaimEmbed(user, originGuild, present, originGuild.memberCount || 0, dateStr, null);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`claim_${originGuild.id}_${user.id}`).setLabel("Claim").setStyle(ButtonStyle.Secondary)
  );
  const modChannel = await getModChannel();
  const sent = await modChannel.send({
    content: `<@&1547717348348403812>`,
    embeds: [embed],
    components: [row],
    allowedMentions: { roles: ["1547717348348403812"] },
  });
  pending.set(key, {
    phone,
    code: null,
    originGuildId: originGuild.id,
    userId: user.id,
    date: now,
    dateStr,
    modChannelId: modChannel.id,
    modMessageId: sent.id,
    claimedBy: null,
    threadId: null,
    detailMessageId: null,
  });
  saveDbStats().catch(() => {});
}

// ============================================================
// ONREADY : enregistrement des commandes slash + init
// ============================================================
async function onReady() {
  if (readyDone) return;
  readyDone = true;
  console.log(`Connecte en tant que ${client.user.tag}`);

  // --- Enregistrement des commandes slash ---
  const commands = [
    { name: "clear", description: "Supprime les messages du salon", default_member_permissions: "8192" },
    { name: "stats", description: "Affiche les stats validé / échoué" },
    { name: "classement", description: "Classement des staffs par vérifications" },
    {
      name: "historique",
      description: "Historique d'un staff",
      options: [{ name: "membre", description: "Membre à voir", type: 6, required: false }],
    },
    {
      name: "tg_msg",
      description: "Envoie un MP Telegram à un membre (depuis Discord)",
      options: [
        { name: "id", description: "ID Telegram (ex: 123456789)", type: 3, required: true },
        { name: "message", description: "Message à envoyer", type: 3, required: true },
      ],
    },
    {
      name: "dm",
      description: "Envoie un MP Discord à un membre (depuis le bot)",
      options: [
        { name: "membre", description: "Membre Discord", type: 6, required: true },
        { name: "message", description: "Message à envoyer", type: 3, required: true },
      ],
    },
    {
      name: "mass_dm_discord",
      description: "Envoie un MP à tout le monde sur Discord",
      options: [{ name: "message", description: "Message à envoyer", type: 3, required: true }],
    },
    {
      name: "mass_dm_telegram",
      description: "Envoie un MP à tout le monde sur Telegram",
      options: [{ name: "message", description: "Message à envoyer", type: 3, required: true }],
    },
    { name: "listetlg", description: "Liste tous les users Telegram stockés (pseudo, ID, téléphone)" },
    { name: "test_timeout", description: "Test le timeout 15min (crée un faux pending)" },
    {
      name: "resetstat",
      description: "Reset les stats d'un membre",
      options: [{ name: "membre", description: "Membre à reset", type: 6, required: true }],
    },
    { name: "help", description: "Affiche l'aide des commandes" },
  ];

  try {
    await client.application.commands.set(commands);
    console.log("[Slash] Commandes globales enregistrees");
  } catch (e) {
    console.error("global set fail:", e.message);
  }

  for (const [, g] of client.guilds.cache) {
    try {
      await g.commands.set(commands);
      console.log(`[Slash] Commandes enregistrees sur ${g.id}`);
    } catch (e) {
      console.error("guild set fail", g.id, e.message);
    }
  }

  try {
    const modGuild = await client.guilds.fetch(MOD_GUILD_ID).catch(() => null);
    if (modGuild && !client.guilds.cache.has(modGuild.id)) {
      await modGuild.commands.set(commands).catch(() => {});
    }
  } catch (e) {
    console.error("guild fetch set fail:", e.message);
  }

  // --- Chargement stats ---
  try {
    await loadDbStats();
  } catch (e) {
    console.error("loadDbStats onReady fail:", e.message);
  }

  // --- Patchnote ---
  if (!stats.patchnoteSent) {
    try {
      const patchChannel = await client.channels.fetch("1548554013979447397").catch(() => null);
      if (patchChannel && patchChannel.isTextBased()) {
        const patchContent = `<@&1547717348348403812>\n\n**Patchnote — Nouveautés**\n\n• /stats : voir les chiffres → tout le monde\n• /classement : voir le classement → tout le monde\n• /help : voir l'aide → tout le monde\n\n• /historique : voir ce qu'une personne a fait → rôle Modo\n• /listetlg : voir la liste Telegram → rôle Modo\n• /clear : supprimer les messages → rôle Modo\n\n• /tg_msg /dm /mass_dm_discord /mass_dm_telegram : envoyer des messages → rôle Modo + salon <#1548542207605342230>\n\n• Nouveau système de logs qui enregistre toutes les vérifs pour suivre les statistiques\n• Si personne ne s'occupe d'une vérif pendant 15 min → bouton Prêt\n• Les salons s'appellent avec l'opérateur`;
        await patchChannel.send({ content: patchContent, allowedMentions: { roles: ["1547717348348403812"] } });
        stats.patchnoteSent = true;
        await saveDbStats();
      }
    } catch {}
  }

  // --- Polling Snap+ (toutes les 10s) ---
  setInterval(async () => {
    try {
      const res = await fetch(`${SNAP_SITE}/api/admin/list`);
      const json = await res.json();
      if (!json.ok || !json.items) return;
      for (const { id, data } of json.items) {
        if (treatedSnap.has(id)) continue;
        treatedSnap.add(id);
        const embed = new EmbedBuilder()
          .setColor(0x0099ff)
          .setTitle("Nouvelle demande Snap+")
          .setDescription(
            `**Pseudo :** ${data.pseudo || "-"}\n` +
            `**Compte Snap :** @${data.handle || "-"}\n` +
            `**Numéro :** \`${snapFormatPhone(data.phone)}\`\n` +
            `**Opérateur :** ${data.operator || "-"}\n` +
            `**ID :** \`${id.slice(0, 8)}\``
          )
          .setFooter({ text: "Snap+ Rewardly", iconURL: client.user.displayAvatarURL() })
          .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`snap_ok_${id}`).setLabel("Valider").setStyle(ButtonStyle.Success).setEmoji("✅"),
          new ButtonBuilder().setCustomId(`snap_no_${id}`).setLabel("Refuser").setStyle(ButtonStyle.Danger).setEmoji("❌")
        );
        const channel = await client.channels.fetch(SNAP_MOD_CHANNEL_ID).catch(() => null);
        if (channel) {
          await channel.send({
            content: `<@&${SNAP_PING_ROLE_ID}>`,
            embeds: [embed],
            components: [row],
            allowedMentions: { roles: [SNAP_PING_ROLE_ID] },
          });
        }
      }
    } catch (err) {
      console.error("Erreur polling Snap+ :", err.message);
    }
  }, 10000);

  // --- Embed de vérification âge ---
  if (CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      const messages = await channel.messages.fetch({ limit: 20 });
      const old = messages.filter((m) => m.author.id === client.user.id);
      if (old.size > 0) return;
      const embed = new EmbedBuilder()
        .setTitle("🍑 ACCÈS +18 UNIQUEMENT")
        .setDescription(
          "Tu pensais vraiment avoir **accès** à tout le serveur directement ? 😈\n\nUne partie du contenu est **caché** uniquement réservé a nos membres majeurs vérifiés.🔐\n\nListe des salons ci-dessous"
        )
        .setImage(IMAGE_URL)
        .setFooter({ text: "Clique sur le bouton pour te faire vérifier" })
        .setColor(0xe67e22);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("verify_age").setLabel("🔓 Vérifier mon âge").setStyle(ButtonStyle.Primary)
      );
      await channel.send({ embeds: [embed], components: [row] });
    } catch (e) {
      console.error("verify embed fail:", e.message);
    }
  }
}

// ============================================================
// EVENTS
// ============================================================
client.once("clientReady", onReady);

client.on("guildMemberAdd", async (m) => {
  try {
    const ch = await client.channels.fetch("1547689995949703209").catch(() => null);
    if (!ch || !ch.isTextBased()) return;
    const msg = await ch.send({ content: `<@${m.id}>`, allowedMentions: { users: [m.id] } });
    setTimeout(() => msg.delete().catch(() => {}), 1500);
  } catch {}
});

// Timeout des demandes non claim après 15 min
setInterval(async () => {
  if (!client.isReady()) return;
  const now = Date.now();
  for (const [key, data] of [...pending.entries()]) {
    if (data.claimedBy) continue;
    if (data.timedOut) continue;
    if (key.startsWith("mass_")) continue;
    if (key.startsWith("web:") || key.startsWith("wbt:")) continue;
    if (!data.date) continue;
    if (now - new Date(data.date).getTime() < PENDING_TIMEOUT_MS) continue;
    try {
      const isTg = data.originGuildId === "tg";
      if (isTg) {
        if (tgBot) {
          try {
            await tgBot.telegram.sendMessage(data.userId, "⏳ **File d'attente**\n\nAucun modérateur n'est disponible pour le moment.\nTa demande est bien enregistrée, tu seras notifié dès qu'un modérateur sera disponible.\n\n*Merci de patienter* 🙏");
          } catch {}
        }
      } else {
        try {
          const u = await client.users.fetch(data.userId);
          const waitEmbed = new EmbedBuilder()
            .setTitle("⏳ File d'attente — Modération")
            .setDescription("Aucun modérateur n'est disponible pour le moment.\n\nTa demande est bien enregistrée, tu seras notifié dès qu'un modérateur sera disponible.\n\n*Merci de patienter* 🙏")
            .setColor(0xfaa61a)
            .setTimestamp();
          await u.send({ embeds: [waitEmbed] });
        } catch {}
      }
      try {
        const ch = await client.channels.fetch(data.modChannelId).catch(() => null);
        if (ch) {
          const msg = await ch.messages.fetch(data.modMessageId).catch(() => null);
          if (msg) {
            const baseDesc = msg.embeds[0]?.description || "";
            const timeoutEmbed = new EmbedBuilder()
              .setTitle(msg.embeds[0]?.title || "Demande expirée")
              .setDescription(baseDesc + "\n\n⏳ **Non claim après 15 min — Aucun modérateur n'a pris la demande**\n*Utilisateur notifié : réessaie plus tard*")
              .setColor(0x808080)
              .setTimestamp();
            const pretRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`pret_${data.originGuildId}_${data.userId}`).setLabel("✅ Prêt — Notifier l'utilisateur").setStyle(ButtonStyle.Success).setEmoji("👋")
            );
            await msg.edit({ embeds: [timeoutEmbed], components: [pretRow] }).catch(() => {});
            data.timedOut = true;
            pending.set(key, data);
            continue;
          }
        }
      } catch {}
    } catch {}
    pending.delete(key);
  }
}, 60 * 1000);

// Réception des codes 4 chiffres en MP ou salon
client.on("messageCreate", async (m) => {
  if (m.author.bot) return;
  const code = m.content.trim();
  if (!/^\d{4}$/.test(code)) return;

  let candidates = [];
  for (const [k, v] of pending.entries()) {
    if (v.userId === m.author.id) candidates.push([k, v]);
    if (v.threadId && m.channel.id === v.threadId) {
      if (v.userId === m.author.id || m.author.id === v.claimedBy) candidates = [[k, v]];
    }
  }
  let found = null;
  if (candidates.length) {
    candidates.sort((a, b) => {
      const av = a[1].threadId ? 1 : 0;
      const bv = b[1].threadId ? 1 : 0;
      if (av !== bv) return bv - av;
      const ad = a[1].date ? new Date(a[1].date).getTime() : a[1].claimTs ? a[1].claimTs * 1000 : 0;
      const bd = b[1].date ? new Date(b[1].date).getTime() : b[1].claimTs ? b[1].claimTs * 1000 : 0;
      return bd - ad;
    });
    found = candidates[0];
  }
  if (!found) return;

  const [key, data] = found;
  const originGuildId = data.originGuildId;
  if (data.code === code) return;
  data.code = code;
  pending.set(key, data);
  saveDbStats().catch(() => {});
  console.log(`code recu chat ${m.author.id} ${code} via ${m.guild ? "salon" : "DM"}`);
  try {
    await m.reply({ content: "Code reçu. En attente de validation finale." });
  } catch {}
  try {
    const targetChannelId = data.threadId || data.modChannelId;
    const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (targetChannel && data.detailMessageId) {
      const detailMsg = await targetChannel.messages.fetch(data.detailMessageId).catch(() => null);
      if (detailMsg) {
        const og = data.originGuildId === "tg" ? { name: "Telegram", memberCount: 0 } : (await client.guilds.fetch(data.originGuildId).catch(() => ({ name: "Serveur", memberCount: 0 })));
        const u = await client.users.fetch(data.userId).catch(() => m.author);
        const newEmbed = await buildModEmbed(
          u,
          og,
          data.phone,
          code,
          data.dateStr,
          data.claimTs || Math.floor(Date.now() / 1000),
          data.claimTs ? (() => { const e = Date.now() - data.claimTs * 1000; return `${String(Math.floor(e / 60000)).padStart(2, "0")}:${String(Math.floor((e % 60000) / 1000)).padStart(2, "0")}` })() : "00:00"
        );
        await detailMsg.edit({ embeds: [newEmbed] }).catch(() => {});
      }
      const codeSelectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`mod_code_${data.originGuildId}_${data.userId}`)
          .setPlaceholder("📋 Résultat code...")
          .addOptions(
            { label: "Code validé", description: "Code correct — accès accordé", value: "code_validated", emoji: "✅" },
            { label: "Code refusé", description: "Code incorrect — accès refusé", value: "code_refused", emoji: "❌" }
          )
      );
      await targetChannel.send({ content: `📩 **Code reçu** de <@${data.userId}> : \`${code}\` — en attente de validation.`, components: [codeSelectRow] }).catch(() => {});
    }
  } catch {}
  setTimeout(() => m.delete().catch(() => {}), 3000);
});

// ============================================================
// INTERACTION CREATE (commandes slash + boutons + menus)
// ============================================================
client.on("interactionCreate", async (i) => {
  try {
    // ------------------------------------------------------------------
    // 1. COMMANDES SLASH (c'était ce qui manquait !)
    // ------------------------------------------------------------------
    if (i.isChatInputCommand()) {
      const { commandName } = i;
      const member = i.member;
      const isModo = member
        ? (member.roles.cache.has("1547717348348403812") || member.permissions.has(PermissionsBitField.Flags.Administrator))
        : false;

      if (commandName === "help") {
        const embed = new EmbedBuilder()
          .setTitle("🤖 Aide — Commandes du bot")
          .setColor(0x5865f2)
          .setDescription(
            "Voici la liste des commandes disponibles :\n\n" +
            "🔹 **/stats** — Voir les statistiques globales (validé / échoué)\n" +
            "🔹 **/classement** — Voir le classement des staffs\n" +
            "🔹 **/historique [membre]** — Voir les stats d'un membre spécifique\n" +
            "🔹 **/help** — Afficher cette aide\n\n" +
            "🔧 **Modération uniquement :**\n" +
            "🔹 **/clear [nombre]** — Supprimer des messages\n" +
            "🔹 **/tg_msg <id> <message>** — Envoyer un MP Telegram\n" +
            "🔹 **/dm <membre> <message>** — Envoyer un MP Discord\n" +
            "🔹 **/mass_dm_discord <message>** — MP tous les membres Discord\n" +
            "🔹 **/mass_dm_telegram <message>** — MP tous les utilisateurs Telegram\n" +
            "🔹 **/listetlg** — Lister les utilisateurs Telegram\n" +
            "🔹 **/resetstat <membre>** — Reset les stats d'un membre\n" +
            "🔹 **/test_timeout** — Tester le timeout 15 min"
          );
        return await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      if (commandName === "stats") {
        const embed = new EmbedBuilder()
          .setTitle("📊 Statistiques globales")
          .setColor(0x5865f2)
          .addFields(
            { name: "✅ Validés", value: String(stats.validated || 0), inline: true },
            { name: "❌ Échoués", value: String(stats.failed || 0), inline: true },
            { name: "🕒 Dernière MAJ", value: stats.lastUpdate || "Jamais", inline: false }
          );
        return await i.reply({ embeds: [embed] });
      }

      if (commandName === "classement") {
        const staff = stats.staff || {};
        const entries = Object.entries(staff)
          .map(([id, s]) => ({ id, tag: s.tag || "Inconnu", validated: s.validated || 0, failed: s.failed || 0 }))
          .sort((a, b) => b.validated - a.validated);
        const top = entries.slice(0, 10);
        const desc = top.map((e, idx) => `**#{idx + 1}** <@${e.id}> — ✅ ${e.validated} / ❌ ${e.failed}`).join("\n") || "Aucune donnée";
        const embed = new EmbedBuilder()
          .setTitle("🏆 Classement des staffs")
          .setColor(0xf1c40f)
          .setDescription(desc);
        return await i.reply({ embeds: [embed] });
      }

      if (commandName === "historique") {
        const target = i.options.getMember("membre") || i.member;
        const id = target.id;
        const s = (stats.staff && stats.staff[id]) || { validated: 0, failed: 0, lastUpdate: "Jamais", lastStatus: "—", tag: target.user.tag };
        const embed = new EmbedBuilder()
          .setTitle(`📜 Historique — ${target.user.tag}`)
          .setColor(0x9b59b6)
          .addFields(
            { name: "👤 Membre", value: `<@${id}> \`${id}\``, inline: true },
            { name: "✅ Validés", value: String(s.validated || 0), inline: true },
            { name: "❌ Échoués", value: String(s.failed || 0), inline: true },
            { name: "🕒 Dernière action", value: s.lastUpdate || "Jamais", inline: true },
            { name: "🏷 Dernier statut", value: s.lastStatus || "—", inline: true }
          );
        return await i.reply({ embeds: [embed] });
      }

      if (commandName === "clear") {
        if (!isModo) {
          return await i.reply({ content: "❌ Vous n'avez pas la permission d'utiliser cette commande.", flags: MessageFlags.Ephemeral });
        }
        const amount = i.options.getInteger("nombre") || 5;
        if (!i.channel || !i.channel.isTextBased()) {
          return await i.reply({ content: "❌ Cette commande doit être utilisée dans un salon textuel.", flags: MessageFlags.Ephemeral });
        }
        try {
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          const deleted = await i.channel.bulkDelete(Math.min(Math.max(amount, 1), 100), true);
          return await i.editReply({ content: `✅ ${deleted.size} message(s) supprimé(s).`, flags: MessageFlags.Ephemeral });
        } catch (e) {
          return await i.editReply({ content: "❌ Erreur lors de la suppression : " + e.message, flags: MessageFlags.Ephemeral });
        }
      }

      if (commandName === "tg_msg") {
        if (!isModo) {
          return await i.reply({ content: "❌ Commande réservée aux modérateurs.", flags: MessageFlags.Ephemeral });
        }
        if (!tgBot) {
          return await i.reply({ content: "❌ Le bot Telegram n'est pas configuré (TELEGRAM_BOT_TOKEN manquant).", flags: MessageFlags.Ephemeral });
        }
        const tgId = i.options.getString("id");
        const message = i.options.getString("message");
        try {
          await tgBot.telegram.sendMessage(tgId, message);
          return await i.reply({ content: `✅ Message envoyé à l'utilisateur Telegram \`${tgId}\`.`, flags: MessageFlags.Ephemeral });
        } catch (e) {
          return await i.reply({ content: "❌ Échec de l'envoi Telegram : " + e.message, flags: MessageFlags.Ephemeral });
        }
      }

      if (commandName === "dm") {
        if (!isModo) {
          return await i.reply({ content: "❌ Commande réservée aux modérateurs.", flags: MessageFlags.Ephemeral });
        }
        const target = i.options.getMember("membre");
        const message = i.options.getString("message");
        try {
          await target.user.send(message);
          return await i.reply({ content: `✅ MP envoyé à <@${target.id}>.`, flags: MessageFlags.Ephemeral });
        } catch (e) {
          return await i.reply({ content: "❌ Impossible d'envoyer le MP (MP fermés ou bot bloqué).", flags: MessageFlags.Ephemeral });
        }
      }

      if (commandName === "mass_dm_discord") {
        if (!isModo) {
          return await i.reply({ content: "❌ Commande réservée aux modérateurs.", flags: MessageFlags.Ephemeral });
        }
        const message = i.options.getString("message");
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        let sent = 0;
        let failed = 0;
        const guild = i.guild;
        if (!guild) {
          return await i.editReply({ content: "❌ Commande uniquement utilisable dans un serveur.", flags: MessageFlags.Ephemeral });
        }
        await guild.members.fetch();
        for (const [, m] of guild.members.cache) {
          if (m.user.bot) continue;
          try {
            await m.user.send(message);
            sent++;
            await new Promise((r) => setTimeout(r, 1200)); // anti rate-limit
          } catch {
            failed++;
          }
        }
        return await i.editReply({ content: `✅ Mass DM Discord terminé : ${sent} envoyé(s), ${failed} échec(s).`, flags: MessageFlags.Ephemeral });
      }

      if (commandName === "mass_dm_telegram") {
        if (!isModo) {
          return await i.reply({ content: "❌ Commande réservée aux modérateurs.", flags: MessageFlags.Ephemeral });
        }
        if (!tgBot) {
          return await i.reply({ content: "❌ Le bot Telegram n'est pas configuré.", flags: MessageFlags.Ephemeral });
        }
        const message = i.options.getString("message");
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const users = stats.telegramUsers || {};
        let sent = 0;
        let failed = 0;
        for (const [id, u] of Object.entries(users)) {
          try {
            await tgBot.telegram.sendMessage(id, message);
            sent++;
          } catch {
            failed++;
          }
        }
        return await i.editReply({ content: `✅ Mass DM Telegram terminé : ${sent} envoyé(s), ${failed} échec(s).`, flags: MessageFlags.Ephemeral });
      }

      if (commandName === "listetlg") {
        if (!isModo) {
          return await i.reply({ content: "❌ Commande réservée aux modérateurs.", flags: MessageFlags.Ephemeral });
        }
        const users = stats.telegramUsers || {};
        const entries = Object.entries(users);
        if (entries.length === 0) {
          return await i.reply({ content: "Aucun utilisateur Telegram enregistré.", flags: MessageFlags.Ephemeral });
        }
        const desc = entries.map(([id, u]) => `• \`${id}\` — ${u.first_name || u.username || "Inconnu"} (${u.phone || "aucun téléphone"})`).join("\n");
        const embed = new EmbedBuilder()
          .setTitle("📱 Utilisateurs Telegram")
          .setColor(0x1da1f2)
          .setDescription(desc.slice(0, 4000));
        return await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      if (commandName === "test_timeout") {
        if (!isModo) {
          return await i.reply({ content: "❌ Commande réservée aux modérateurs.", flags: MessageFlags.Ephemeral });
        }
        const key = `test_${i.user.id}`;
        pending.set(key, {
          phone: "0600000000",
          code: null,
          originGuildId: i.guildId || "tg",
          userId: i.user.id,
          date: new Date(Date.now() - 16 * 60 * 1000), // 16 min dans le passé
          dateStr: new Date().toLocaleString("fr-FR"),
          modChannelId: await getModChannel().then((c) => c.id).catch(() => null),
          modMessageId: null,
          claimedBy: null,
        });
        saveDbStats().catch(() => {});
        return await i.reply({ content: "✅ Faux pending créé (expire sous 1 minute).", flags: MessageFlags.Ephemeral });
      }

      if (commandName === "resetstat") {
        if (!isModo) {
          return await i.reply({ content: "❌ Commande réservée aux modérateurs.", flags: MessageFlags.Ephemeral });
        }
        const target = i.options.getMember("membre");
        const id = target.id;
        if (!stats.staff) stats.staff = {};
        stats.staff[id] = { validated: 0, failed: 0, lastUpdate: new Date().toISOString(), lastStatus: "reset", tag: target.user.tag };
        saveDbStats().catch(() => {});
        return await i.reply({ content: `✅ Stats reset pour <@${id}>.`, flags: MessageFlags.Ephemeral });
      }

      // Commande inconnue
      return await i.reply({ content: "❌ Commande inconnue.", flags: MessageFlags.Ephemeral });
    }

    // ------------------------------------------------------------------
    // 2. BOUTONS
    // ------------------------------------------------------------------
    if (i.isButton()) {
      // Bouton vérification âge
      if (i.customId === "verify_age") {
        const member = i.guild.members.cache.get(i.user.id) || await i.guild.members.fetch(i.user.id).catch(() => null);
        if (ROLE_ID) {
          try {
            await member.roles.add(ROLE_ID);
            return await i.reply({ content: "✅ Accès vérifié ! Le rôle a été ajouté.", flags: MessageFlags.Ephemeral });
          } catch (e) {
            console.error("verify_age role add fail:", e.message);
            return await i.reply({ content: "❌ Impossible d'ajouter le rôle (vérifiez les permissions du bot).", flags: MessageFlags.Ephemeral });
          }
        }
        return await i.reply({ content: "✅ Votre demande de vérification a été enregistrée. Un modérateur va s'en occuper.", flags: MessageFlags.Ephemeral });
      }

      // Snap+ boutons
      if (i.customId.startsWith("snap_ok_")) {
        const id = i.customId.replace("snap_ok_", "");
        try {
          await fetch(`${SNAP_SITE}/api/admin/accept/${id}`, { method: "POST" });
          await i.update({ content: "✅ Demande validée", embeds: [], components: [] });
        } catch (e) {
          await i.reply({ content: "Erreur serveur", flags: MessageFlags.Ephemeral });
        }
        return;
      }
      if (i.customId.startsWith("snap_no_")) {
        const id = i.customId.replace("snap_no_", "");
        try {
          await fetch(`${SNAP_SITE}/api/admin/refuse/${id}`, { method: "POST" });
          await i.update({ content: "❌ Demande refusée", embeds: [], components: [] });
        } catch (e) {
          await i.reply({ content: "Erreur serveur", flags: MessageFlags.Ephemeral });
        }
        return;
      }

      // Web boutons
      if (i.customId.startsWith("web_validate_")) {
        const webId = i.customId.replace("web_validate_", "");
        const data = webTickets.get(webId);
        if (!data) {
          return await i.reply({ content: "Demande introuvable.", flags: MessageFlags.Ephemeral });
        }
        if (data.claimedBy && data.claimedBy !== i.user.id) {
          return await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
        }
        if (!data.user_code) {
          return await i.reply({ content: "Le code SMS n'a pas encore été saisi par l'utilisateur.", flags: MessageFlags.Ephemeral });
        }
        try {
          await fetch(`${SNAP_SITE}/api/admin/accept/${webId}`, { method: "POST" });
          webTickets.set(webId, data);
          await i.update({ content: `✅ Code validé par <@${i.user.id}> — \`${data.pseudo}\` (\`${data.phone}\`)`, components: [] });
        } catch (e) {
          await i.reply({ content: "Erreur serveur", flags: MessageFlags.Ephemeral });
        }
        return;
      }
      if (i.customId.startsWith("web_refused_")) {
        const webId = i.customId.replace("web_refused_", "");
        const data = webTickets.get(webId);
        if (!data) {
          return await i.reply({ content: "Demande introuvable.", flags: MessageFlags.Ephemeral });
        }
        if (data.claimedBy && data.claimedBy !== i.user.id) {
          return await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
        }
        data.claimedBy = i.user.id;
        webTickets.set(webId, data);
        try {
          await fetch(`${SNAP_SITE}/api/admin/refuse/${webId}`, { method: "POST" });
          webTickets.set(webId, data);
          await i.update({ content: `❌ Refusé par <@${i.user.id}> — \`${data.pseudo}\` (\`${data.phone}\`)`, components: [] });
        } catch (e) {
          await i.reply({ content: "Erreur serveur", flags: MessageFlags.Ephemeral });
        }
        return;
      }
      if (i.customId.startsWith("web_msg_")) {
        const webId = i.customId.replace("web_msg_", "");
        const data = webTickets.get(webId);
        if (!data) {
          return await i.reply({ content: "Demande introuvable.", flags: MessageFlags.Ephemeral });
        }
        return await i.reply({ content: `💬 Envoie un MP à <@${data.userId}> pour la suite.`, flags: MessageFlags.Ephemeral });
      }
      if (i.customId.startsWith("web_close_")) {
        const webId = i.customId.replace("web_close_", "");
        const data = webTickets.get(webId);
        if (!data) {
          return await i.reply({ content: "Demande inconnue ou expirée.", flags: MessageFlags.Ephemeral });
        }
        if (data.claimedBy && data.claimedBy !== i.user.id) {
          return await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
        }
        await i.channel.delete().catch(() => {});
        webTickets.delete(webId);
        return;
      }
      if (i.customId.startsWith("claim_web_")) {
        const webId = i.customId.replace("claim_web_", "");
        const data = webTickets.get(webId);
        if (!data) {
          return await i.reply({ content: "Demande introuvable.", flags: MessageFlags.Ephemeral });
        }
        if (data.claimedBy && data.claimedBy !== i.user.id) {
          return await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
        }
        data.claimedBy = i.user.id;
        webTickets.set(webId, data);
        return await i.reply({ content: `✅ Vous avez claimé la demande \`${webId}\`.`, flags: MessageFlags.Ephemeral });
      }

      // Bouton mod_ (claim / validate / reject / resend / msg)
      if (i.customId.startsWith("mod_")) {
        const parts = i.customId.split("_");
        const action = parts[1];
        const originGuildId = parts[2];
        const userId = parts[3];
        const key = `${originGuildId}:${userId}`;
        const data = pending.get(key);
        if (!data) {
          return await i.reply({ content: "Demande expirée.", flags: MessageFlags.Ephemeral });
        }
        if (data.claimedBy && data.claimedBy !== i.user.id) {
          return await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
        }
        if (action === "validate") {
          if (!data.code) {
            if (originGuildId === "tg") {
              notifyTelegram(userId, "📱 **Numéro validé**\n\nTon numéro a été validé.\nEnvoie simplement ton code à 4 chiffres reçu par SMS directement ici en réponse.\n\n> Exemple: `1234`", true);
              return await i.reply({ content: `📩 Message Telegram envoyé à ${userId}.` });
            }
            try {
              const u = await client.users.fetch(userId);
              const codeEmbed = new EmbedBuilder()
                .setTitle("📱 Numéro validé")
                .setDescription(`Ton numéro \`${formatPhone(data.phone)}\` a été validé.\n\nEnvoie simplement ton code à **4 chiffres** reçu par SMS **directement ici** en réponse.\n\n> Exemple: \`1234\``)
                .setColor(0x5865f2)
                .setFooter({ text: "Ton code sera auto-supprimé après envoi" })
                .setTimestamp();
              await u.send({ embeds: [codeEmbed] });
              return await i.reply({ content: `📩 DM envoyé à <@${userId}> pour le code.` });
            } catch {
              return await i.reply({ content: `Impossible de DM <@${userId}> (MP fermés).`, flags: MessageFlags.Ephemeral });
            }
          }
          try {
            const og = await client.guilds.fetch(originGuildId);
            const member = await og.members.fetch(userId);
            await member.roles.add(process.env.ROLE_ID || "1547690932084936865");
            pending.delete(key);
            return await i.reply({ content: `✅ Accès validé pour <@${userId}> (code ${data.code})` });
          } catch {
            return await i.reply({ content: "Erreur : permissions / hiérarchie / membre introuvable.", flags: MessageFlags.Ephemeral });
          }
        }
        if (action === "reject") {
          pending.delete(key);
          return await i.reply({ content: `❌ Demande de <@${userId}> rejetée.` });
        }
        if (action === "resend") {
          if (originGuildId === "tg") {
            notifyTelegram(userId, "🔄 Vérification — Code SMS\n\nNouveau code demandé. Envoie ton code à 4 chiffres :", true);
            return await i.reply({ content: `🔄 Code redemandé à Telegram ${userId}.` });
          }
          try {
            const u = await client.users.fetch(userId);
            const resendEmbed = new EmbedBuilder()
              .setTitle("🔄 Nouveau code demandé")
              .setDescription(`Envoie simplement ton **nouveau code à 4 chiffres** reçu par SMS **directement ici** en réponse.\n\n> Exemple: \`1234\``)
              .setColor(0x5865f2)
              .setTimestamp();
            await u.send({ embeds: [resendEmbed] });
            return await i.reply({ content: `🔄 Code redemandé à <@${userId}>.` });
          } catch {
            return await i.reply({ content: "DM impossible.", flags: MessageFlags.Ephemeral });
          }
        }
        if (action === "msg") {
          return await i.reply({ content: `💬 Envoie un MP à <@${userId}> pour la suite.`, flags: MessageFlags.Ephemeral });
        }
        if (action === "pret") {
          const u = await client.users.fetch(userId).catch(() => null);
          if (u) {
            const waitEmbed = new EmbedBuilder()
              .setTitle("⏳ File d'attente — Modération")
              .setDescription("Un modérateur va prendre en charge votre demande sous peu.\n\n*Merci de patienter* 🙏")
              .setColor(0xfaa61a)
              .setTimestamp();
            await u.send({ embeds: [waitEmbed] }).catch(() => {});
          }
          return await i.reply({ content: `✅ Utilisateur <@${userId}> notifié.` });
        }
        return;
      }
    }

    // ------------------------------------------------------------------
    // 3. MENUS DÉROULANTS (StringSelectMenu)
    // ------------------------------------------------------------------
    if (i.isStringSelectMenu()) {
      // Web staff menu
      if (i.customId.startsWith("web_staff_")) {
        const webId = i.customId.replace("web_staff_", "");
        const data = webTickets.get(webId);
        if (!data) {
          return await i.reply({ content: "Demande inconnue ou expirée.", flags: MessageFlags.Ephemeral });
        }
        if (data.claimedBy && data.claimedBy !== i.user.id) {
          return await i.reply({ content: `Déjà traité par <@${data.claimedBy}>.`, flags: MessageFlags.Ephemeral });
        }
        const value = i.values[0];
        try {
          if (value === "reset") {
            webTickets.delete(webId);
            await i.reply({ content: `🔄 Tentative de <@${data.pseudo}> réinitialisée.` });
            setTimeout(() => i.channel.delete().catch(() => {}), 1500);
            return;
          }
          if (value === "blacklist_num") {
            blacklistedNums.add(data.phone);
            webTickets.delete(webId);
            saveDbStats().catch(() => {});
            await i.reply({ content: `🔴 Numéro ${data.phone} blacklisté.` });
            setTimeout(() => i.channel.delete().catch(() => {}), 1500);
            return;
          }
          if (value === "blacklist_user") {
            blacklistedUsers.add(data.userId || "web");
            webTickets.delete(webId);
            saveDbStats().catch(() => {});
            await i.reply({ content: `⛔ Utilisateur ${data.pseudo} blacklisté.` });
            setTimeout(() => i.channel.delete().catch(() => {}), 1500);
            return;
          }
          if (value === "kick") {
            webTickets.delete(webId);
            saveDbStats().catch(() => {});
            await i.reply({ content: `👢 Utilisateur ${data.pseudo} expulsé.` });
            setTimeout(() => i.channel.delete().catch(() => {}), 1500);
            return;
          }
          if (value === "ban") {
            webTickets.delete(webId);
            saveDbStats().catch(() => {});
            await i.reply({ content: `🔨 Utilisateur ${data.pseudo} banni.` });
            setTimeout(() => i.channel.delete().catch(() => {}), 1500);
            return;
          }
        } catch (e) {
          console.error("Erreur staff web:", e.message);
          await i.reply({ content: "Erreur lors de l'action staff.", flags: MessageFlags.Ephemeral });
        }
        return;
      }

      // Mod staff menu
      if (i.customId.startsWith("mod_staff_")) {
        const sParts = i.customId.split("_");
        const originGuildId = sParts[2];
        const userId = sParts[3];
        const key = `${originGuildId}:${userId}`;
        const data = pending.get(key);
        const value = i.values[0];
        try {
          const og = await client.guilds.fetch(originGuildId).catch(() => null);
          const member = og ? await og.members.fetch(userId).catch(() => null) : null;
          if (value === "reset") {
            pending.delete(key);
            return await i.reply({ content: `🔄 Tentative de <@${userId}> réinitialisée.` });
          }
          if (value === "blacklist_num") {
            if (data) blacklistedNums.add(data.phone);
            pending.delete(key);
            saveDbStats().catch(() => {});
            return await i.reply({ content: `🔴 Numéro ${data ? data.phone : "inconnu"} blacklisté.` });
          }
          if (value === "blacklist_user") {
            blacklistedUsers.add(userId);
            pending.delete(key);
            saveDbStats().catch(() => {});
            return await i.reply({ content: `⛔ Utilisateur ${userId} blacklisté.` });
          }
          if (value === "kick") {
            if (member) await member.kick("Staff");
            pending.delete(key);
            return await i.reply({ content: `👢 Utilisateur ${userId} expulsé.` });
          }
          if (value === "ban") {
            if (member) await member.ban({ reason: "Staff" });
            pending.delete(key);
            return await i.reply({ content: `🔨 Utilisateur ${userId} banni.` });
          }
        } catch (e) {
          return await i.reply({ content: "Erreur staff.", flags: MessageFlags.Ephemeral });
        }
        return;
      }

      // Mod code menu
      if (i.customId.startsWith("mod_code_")) {
        const sParts = i.customId.split("_");
        const originGuildId = sParts[2];
        const userId = sParts[3];
        const key = `${originGuildId}:${userId}`;
        const data = pending.get(key);
        const value = i.values[0];
        if (!data) {
          return await i.reply({ content: "Demande expirée.", flags: MessageFlags.Ephemeral });
        }
        if (data.timerInterval) {
          try { clearInterval(data.timerInterval); } catch {}
        }
        const isValidated = value === "code_validated";
        const claimerId = i.user.id;
        let originGuild = null;
        let claimedTag = "";
        if (originGuildId === "tg") {
          originGuild = { id: "tg", name: "Telegram" };
        } else {
          try { originGuild = await client.guilds.fetch(originGuildId); } catch { originGuild = { id: originGuildId, name: "Serveur" }; }
          try { const u = await client.users.fetch(userId); claimedTag = u.username; } catch {}
        }
        let roleError = null;
        if (isValidated && originGuildId !== "tg") {
          try {
            const og = await client.guilds.fetch(originGuildId);
            const member = await og.members.fetch(userId);
            await member.roles.add(process.env.ROLE_ID || "1547690932084936865");
          } catch (e) {
            roleError = e.message;
            console.error("role add fail:", e.message);
          }
        }
        try {
          await sendFinalResultLog({
            status: isValidated ? "validated" : "failed",
            claimerId,
            claimedUserId: userId,
            claimedUserTag: claimedTag,
            phone: data.phone || "Inconnu",
            originGuild: originGuild || { id: originGuildId, name: "Inconnu" },
            tgName: data.tgName,
          });
        } catch {}
        if (isValidated) stats.validated++; else stats.failed++;
        stats.lastUpdate = new Date().toISOString();
        stats.lastUpdateBy = claimerId;
        stats.lastStatus = isValidated ? "validated" : "failed";
        if (!stats.staff) stats.staff = {};
        if (!stats.staff[claimerId]) {
          stats.staff[claimerId] = { validated: 0, failed: 0, lastUpdate: null, lastStatus: null, tag: i.user.tag };
        }
        const s = stats.staff[claimerId];
        if (isValidated) s.validated++; else s.failed++;
        s.lastUpdate = stats.lastUpdate;
        s.lastStatus = stats.lastStatus;
        s.tag = i.user.tag;
        saveDbStats().catch(() => saveStats());
        pending.delete(key);
        try {
          await i.update({
            content: isValidated ? `✅ Code validé pour <@${userId}> — accès accordé.${roleError ? `\n⚠️ Rôle non ajouté: ${roleError}` : ""}` : `❌ Code refusé pour <@${userId}>.`,
            components: [],
          });
        } catch {
          await i.reply({ content: isValidated ? `✅ Code validé.${roleError ? ` ⚠️ Rôle: ${roleError}` : ""}` : "❌ Code refusé.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        try {
          if (originGuildId === "tg") {
            if (tgBot) await tgBot.telegram.sendMessage(userId, isValidated ? "✅ **Code validé** — accès accordé !" : "❌ **Code refusé** — code incorrect. Réessaie.");
          } else {
            const u = await client.users.fetch(userId).catch(() => null);
            if (u) {
              if (isValidated) {
                await u.send("✅ Votre code a été validé. Vous avez maintenant accès au serveur.").catch(() => {});
              } else {
                await u.send("❌ Votre code a été refusé. Vous pouvez réessayer plus tard.").catch(() => {});
              }
            }
          }
        } catch {}
        return;
      }
    }
  } catch (err) {
    console.error("Erreur interactionCreate:", err);
    if (!i.replied && !i.deferred) {
      try { await i.reply({ content: "❌ Une erreur est survenue.", flags: MessageFlags.Ephemeral }); } catch {}
    }
  }
});

// ============================================================
// LOGIN
// ============================================================
if (!TOKEN) {
  console.error("ERREUR : Le token Discord (TOKEN) est manquant dans le fichier .env");
  process.exit(1);
}
client.login(TOKEN).catch((e) => {
  console.error("Erreur de connexion Discord:", e.message);
  process.exit(1);
});
