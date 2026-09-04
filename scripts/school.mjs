#!/usr/bin/env node
/**
 * school.mjs: read-only CLI over Mashov and Smartschool for the configured parent account.
 * Prints JSON to stdout. Progress/log lines go to stderr.
 *
 * Usage: node scripts/school.mjs <command> [args] [--kid <name>] [--take N] [--page N] [--unread] [--out DIR]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_DIR,
  DEFAULT_DOWNLOAD_DIR,
  HEBREW_DAYS,
  clearSessions,
  loadSession,
  readConfig,
  saveSession,
} from './lib/http.mjs';
import { Mashov } from './lib/mashov.mjs';
import { Smartschool } from './lib/smartschool.mjs';

const log = (line) => process.stderr.write(`${line}\n`);

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args.flags[key] = next;
        i += 1;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

const HELP = `school.mjs commands (all read-only):

  kids                                 list children across both platforms (cached in sessions/kids.json)
  messages [--kid N] [--take 20] [--page 1] [--unread]
                                       inbox list. Mashov: --take/--skip; Smartschool: --page (10 per page)
  message <id> [--kid N]               full message/conversation text plus attachment list
  download <messageId> <fileIdOrIndex> [--kid N] [--out DIR]
                                       save an attachment (default dir: ~/Downloads/school)
  timetable [--kid N] [--date YYYY-MM-DD] [--view daily|weekly]
                                       weekly timetable (Mashov) or dashboard schedule (Smartschool)
  grades [--kid N]                     grades (Mashov)
  homework [--kid N]                   homework (Mashov)
  behavior [--kid N]                   attendance/behavior events (Mashov: behave, Smartschool: lesson events)
  lessons [--kid N]                    lesson history with teacher remarks (Mashov)
  files [--kid N]                      files shared with the student
  notifications [--kid N]              platform notifications
  login <mashov|smartschool> [--otp CODE]
                                       force a fresh login (use --otp to finish Smartschool 2FA)
  logout                               delete cached sessions
  raw <mashov|smartschool> <path> [jsonBody] [--kid N]
                                       call any API path directly (GET for mashov, POST for smartschool)

--kid matches a child's name (substring, case-insensitive). If omitted and only one child exists, it is used.
--json is implied; output is always JSON on stdout.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, ...rest] = args._;
  if (!command || command === 'help' || args.flags.help) {
    console.log(HELP);
    return;
  }
  if (command === 'logout') {
    clearSessions();
    return output({ ok: true, cleared: path.join(CONFIG_DIR, 'sessions') });
  }

  const config = readConfig();
  const mashov = config.mashov ? new Mashov(config.mashov, { log }) : null;
  const smartschool = config.smartschool ? new Smartschool(config.smartschool, { log }) : null;

  if (command === 'login') {
    const which = rest[0];
    if (which === 'mashov' && mashov) {
      const semel = rest[1] || mashov.config.semel;
      const s = await mashov.login(semel);
      return output({ ok: true, provider: 'mashov', semel, user: s.credential?.displayName, children: s.accessToken?.children });
    }
    if (which === 'smartschool' && smartschool) {
      const s = await smartschool.login({ otpCode: args.flags.otp });
      return output({ ok: true, provider: 'smartschool', user: s.user?.userName || s.user?.name || 'logged in' });
    }
    throw new Error('login needs "mashov" or "smartschool" (and that section in config.json)');
  }

  const kids = await resolveKids({ mashov, smartschool, refresh: command === 'kids' || args.flags.refresh });
  if (command === 'kids') return output(kids);

  if (command === 'raw') {
    const [provider, apiPath, body] = rest;
    if (provider === 'mashov') {
      const kid = args.flags.kid ? pickKid(kids, args.flags.kid, 'mashov') : null;
      const res = await mashov.get(apiPath.replace(/^\/?api\//, ''), { semel: kid?.semel || mashov.config.semel });
      return output(res.json ?? res.text);
    }
    if (provider === 'smartschool') {
      return output(await smartschool.post(apiPath.replace(/^\//, ''), body ? JSON.parse(body) : {}));
    }
    throw new Error('raw needs provider mashov|smartschool');
  }

  const kid = pickKid(kids, args.flags.kid);
  const client = kid.provider === 'mashov' ? mashov : smartschool;
  const outDir = args.flags.out || DEFAULT_DOWNLOAD_DIR;
  const take = Number(args.flags.take || 20);
  const page = Number(args.flags.page || 1);
  const unreadOnly = !!args.flags.unread;

  switch (command) {
    case 'messages':
      if (kid.provider === 'mashov') {
        return output({ kid: kidLabel(kid), ...(await client.inbox(kid.semel, { take, skip: Number(args.flags.skip || 0), unreadOnly })) });
      }
      return output({ kid: kidLabel(kid), ...(await client.inbox({ page, unreadOnly, search: args.flags.search || '' })) });

    case 'message': {
      const id = rest[0];
      if (!id) throw new Error('message needs an id (conversationId for Mashov, messageId for Smartschool)');
      if (kid.provider === 'mashov') return output({ kid: kidLabel(kid), ...(await client.conversation(kid.semel, id)) });
      return output({ kid: kidLabel(kid), ...(await client.message(id)) });
    }

    case 'download': {
      const [messageId, fileRef] = rest;
      if (!messageId || fileRef === undefined) throw new Error('download needs <messageId> <fileIdOrIndex>');
      if (kid.provider === 'mashov') {
        // Need the file name: look it up in the conversation (messageId doubles as conversationId for first messages).
        const conversation = await client.conversation(kid.semel, args.flags.conversation || messageId);
        const message = conversation.messages.find((m) => m.messageId === messageId) || conversation.messages[0];
        const file = message.files.find((f) => f.fileId === fileRef) || message.files[Number(fileRef)];
        if (!file) throw new Error(`no attachment ${fileRef} on message ${messageId}`);
        return output(await client.downloadAttachment(kid.semel, message.messageId, file.fileId, file.fileName, outDir));
      }
      const message = await client.message(messageId);
      const file = message.files[Number(fileRef)] || message.files.find((f) => f.fileName === fileRef);
      if (!file) throw new Error(`no attachment ${fileRef} on message ${messageId}`);
      return output(await client.downloadFile(file.fileUrl, file.fileName, outDir));
    }

    case 'timetable':
      if (kid.provider === 'mashov') {
        const byDay = await client.timetable(kid);
        return output({
          kid: kidLabel(kid),
          days: Object.entries(byDay).map(([day, lessons]) => ({ day: Number(day), dayName: HEBREW_DAYS[day], lessons })),
        });
      }
      return output({
        kid: kidLabel(kid),
        ...(await client.schedule(kid, { date: args.flags.date ? new Date(args.flags.date) : new Date(), view: args.flags.view || 'weekly' })),
      });

    case 'grades':
      if (kid.provider === 'mashov') return output({ kid: kidLabel(kid), grades: await client.student(kid, 'grades') });
      return output({ kid: kidLabel(kid), grades: await client.dashboardGrades(kid) });

    case 'homework':
      if (kid.provider === 'mashov') return output({ kid: kidLabel(kid), homework: await client.student(kid, 'homework') });
      return output({ kid: kidLabel(kid), homework: await client.homework(kid) });

    case 'behavior':
      if (kid.provider === 'mashov') return output({ kid: kidLabel(kid), events: await client.student(kid, 'behave') });
      return output({
        kid: kidLabel(kid),
        lessonEvents: await client.events(kid, { moduleId: 4 }),
        outOfClassEvents: await client.events(kid, { moduleId: 5 }),
      });

    case 'lessons':
      if (kid.provider === 'mashov') return output({ kid: kidLabel(kid), lessons: await client.student(kid, 'lessons/history') });
      return output({ kid: kidLabel(kid), lessons: await client.events(kid, { moduleId: 4 }) });

    case 'files':
      if (kid.provider === 'mashov') return output({ kid: kidLabel(kid), files: await client.student(kid, 'files') });
      return output({ kid: kidLabel(kid), ...(await client.fileRepository(kid)) });

    case 'notifications':
      if (kid.provider === 'mashov') return output({ kid: kidLabel(kid), notifications: await client.notifications(kid.semel) });
      return output({ kid: kidLabel(kid), notifications: await client.notifications() });

    default:
      throw new Error(`unknown command "${command}". Run with --help.`);
  }
}

async function resolveKids({ mashov, smartschool, refresh }) {
  const cached = refresh ? null : loadSession('kids');
  if (cached?.kids?.length) return cached.kids;
  const kids = [];
  const errors = [];
  if (mashov) {
    try {
      kids.push(...(await mashov.kids()));
    } catch (error) {
      errors.push(`mashov: ${error.message}`);
    }
  }
  if (smartschool) {
    try {
      kids.push(...(await smartschool.kids()));
    } catch (error) {
      errors.push(`smartschool: ${error.message}`);
    }
  }
  if (!kids.length) throw new Error(`no children found. ${errors.join(' | ')}`);
  for (const line of errors) log(`warning: ${line}`);
  saveSession('kids', { kids });
  return kids;
}

function pickKid(kids, needle, provider) {
  let pool = provider ? kids.filter((k) => k.provider === provider) : kids;
  if (needle) {
    const lower = String(needle).toLowerCase();
    pool = pool.filter((k) => k.name.toLowerCase().includes(lower) || (k.school || '').toLowerCase().includes(lower));
  }
  if (pool.length === 1) return pool[0];
  if (pool.length === 0) throw new Error(`no child matches "${needle}". Known: ${kids.map(kidLabel).join('; ')}`);
  throw new Error(`ambiguous --kid. Choose one of: ${pool.map(kidLabel).join('; ')}`);
}

function kidLabel(kid) {
  return `${kid.name} (${kid.provider}, ${kid.school || ''}${kid.classLabel ? `, ${kid.classLabel}` : ''})`;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
});
