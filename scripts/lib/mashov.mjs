import { CookieJar, htmlToText, loadSession, request, saveSession, schoolYear, writeDownload } from './http.mjs';

const API = 'https://web.mashov.info/api/';

/**
 * Mashov (משו"ב) students/parents portal client.
 * One session per school code (semel): a parent with kids in two schools gets two sessions.
 */
export class Mashov {
  constructor(config, { log = () => {} } = {}) {
    if (!config.username || !config.password || !config.semel) {
      throw new Error('mashov config needs username (ID number), password and semel (school code).');
    }
    this.config = config;
    this.log = log;
    this.sessions = new Map();
  }

  get year() {
    return Number(this.config.year || schoolYear());
  }

  sessionName(semel) {
    return `mashov-${semel}`;
  }

  async session(semel = this.config.semel, { force = false } = {}) {
    semel = Number(semel);
    if (!force && this.sessions.has(semel)) return this.sessions.get(semel);
    let stored = force ? null : loadSession(this.sessionName(semel));
    if (!stored) stored = await this.login(semel);
    const session = { ...stored, jar: new CookieJar(stored.cookies) };
    this.sessions.set(semel, session);
    return session;
  }

  async login(semel) {
    this.log(`mashov: logging in to school ${semel} for year ${this.year}`);
    const body = {
      semel: Number(semel),
      username: String(this.config.username),
      password: this.config.password,
      year: this.year,
      appName: 'info.mashov.students',
      apiVersion: '3',
      appVersion: '3',
      appBuild: '3',
      deviceUuid: 'school-skill',
      devicePlatform: 'node',
      deviceManufacturer: 'school-skill',
      deviceModel: 'cli',
      deviceVersion: process.version,
    };
    const jar = new CookieJar();
    const res = await request(`${API}login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      jar,
    });
    if (res.status !== 200 || !res.json || !res.json.accessToken) {
      const reason = res.headers.get('reason') || res.headers.get('Reason') || '';
      throw new Error(
        `mashov login failed for school ${semel} (HTTP ${res.status}${reason ? `, reason ${reason}` : ''}): ${
          (res.text || '').slice(0, 300)
        }`,
      );
    }
    const csrf = res.headers.get('x-csrf-token') || '';
    const stored = {
      semel: Number(semel),
      cookies: jar.cookies,
      csrf,
      credential: res.json.credential,
      accessToken: res.json.accessToken,
    };
    saveSession(this.sessionName(semel), stored);
    return stored;
  }

  async get(path, { semel = this.config.semel, binary = false, retry = true } = {}) {
    const session = await this.session(semel);
    const res = await request(`${API}${path}`, {
      headers: { 'X-Csrf-Token': session.csrf, Accept: binary ? '*/*' : 'application/json' },
      jar: session.jar,
      binary,
    });
    if ((res.status === 401 || res.status === 403) && retry) {
      this.log(`mashov: HTTP ${res.status} on ${path}, re-logging in`);
      await this.session(semel, { force: true });
      return this.get(path, { semel, binary, retry: false });
    }
    if (res.status >= 400) {
      throw new Error(`mashov GET ${path} failed (HTTP ${res.status}): ${(res.text || '').slice(0, 300)}`);
    }
    return res;
  }

  /** All children visible from the configured account, across schools. */
  async kids() {
    const primary = await this.session(this.config.semel);
    const token = primary.accessToken;
    const kids = [];
    const pushChild = (child, semel, schoolName) =>
      kids.push({
        provider: 'mashov',
        name: `${child.privateName} ${child.familyName}`.trim(),
        school: schoolName,
        semel: Number(semel),
        childGuid: child.childGuid,
        classLabel: child.classCode ? `${child.classCode}${child.classNum ?? ''}` : null,
      });
    const primarySchool = token.schoolSettings?.schoolName || token.schoolOptions?.schoolName || String(this.config.semel);
    for (const child of token.children || []) pushChild(child, this.config.semel, primarySchool);
    for (const extern of token.externChildren || []) {
      if (!extern.bound) {
        kids.push({
          provider: 'mashov',
          name: `${extern.privateName} ${extern.familyName}`.trim(),
          school: extern.schoolName,
          semel: Number(extern.semel),
          childGuid: extern.childGuid,
          classLabel: null,
          note: 'school not bound to this account yet; bind it once in the Mashov web app',
        });
        continue;
      }
      try {
        const other = await this.session(extern.semel);
        const match = (other.accessToken.children || []).find((c) => c.childGuid === extern.childGuid);
        pushChild(match || extern, extern.semel, extern.schoolName);
      } catch (error) {
        pushChild(extern, extern.semel, extern.schoolName);
        kids[kids.length - 1].note = `could not open session for this school: ${error.message}`;
      }
    }
    return kids;
  }

  // ---- mail -------------------------------------------------------------

  async inbox(semel, { take = 20, skip = 0, unreadOnly = false } = {}) {
    const res = await this.get(`mail/inbox/conversations?skip=${skip}&take=${take}`, { semel });
    const total = Number(res.headers.get('x-conversations-count') || 0);
    const conversations = (res.json || [])
      .filter((c) => !unreadOnly || c.isNew)
      .map((c) => ({
        conversationId: c.conversationId,
        subject: (c.subject || '').trim(),
        from: c.messages?.[0]?.senderName || null,
        sendTime: c.sendTime,
        unread: !!c.isNew,
        hasAttachments: !!c.hasAttachments,
        messageCount: c.messages?.length || 0,
      }));
    return { total, skip, take, conversations };
  }

  async conversation(semel, conversationId) {
    const res = await this.get(`mail/conversations/${conversationId}`, { semel });
    const c = res.json;
    return {
      conversationId: c.conversationId,
      subject: (c.subject || '').trim(),
      messages: (c.messages || []).map((m) => ({
        messageId: m.messageId,
        from: m.senderName,
        sendTime: m.sendTime,
        recipients: (m.recipients || []).map((r) => r.displayName).filter(Boolean),
        body: htmlToText(m.body),
        files: (m.files || []).map((f) => ({ fileId: f.fileId, fileName: f.fileName, uploadTime: f.uploadTime })),
      })),
    };
  }

  async downloadAttachment(semel, messageId, fileId, fileName, outDir) {
    const res = await this.get(
      `mail/messages/${messageId}/files/${fileId}/download/${encodeURIComponent(fileName)}`,
      { semel, binary: true },
    );
    const saved = writeDownload(outDir, fileName, res.buffer);
    return { saved, bytes: res.buffer.length, contentType: res.headers.get('content-type') };
  }

  // ---- student data -----------------------------------------------------

  async student(kid, endpoint) {
    const res = await this.get(`students/${kid.childGuid}/${endpoint}`, { semel: kid.semel });
    return res.json;
  }

  async timetable(kid) {
    const rows = await this.student(kid, 'timetable');
    const byDay = {};
    for (const row of rows || []) {
      const day = row.timeTable?.day;
      const entry = {
        lesson: row.timeTable?.lesson,
        subject: row.groupDetails?.subjectName,
        group: row.groupDetails?.groupName,
        teachers: (row.groupDetails?.groupTeachers || []).map((t) => t.teacherName),
        room: row.timeTable?.roomNum,
      };
      (byDay[day] ||= []).push(entry);
    }
    for (const day of Object.keys(byDay)) byDay[day].sort((a, b) => a.lesson - b.lesson);
    return byDay;
  }

  async notifications(semel, take = 20) {
    const res = await this.get(`user/notifications?skip=0&take=${take}`, { semel });
    return res.json;
  }
}
