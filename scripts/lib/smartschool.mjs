import crypto from 'node:crypto';
import { CookieJar, deviceId, htmlToText, loadSession, request, saveSession, writeDownload } from './http.mjs';

const API = 'https://webtopserver.smartschool.co.il/server/';
const AES_KEY = '01234567890000000150778345678901'; // shipped in the Webtop client bundle
const AES_IV = '6543210987654321';

/** Mirrors the client's encryptStringToServer: AES-256-CBC over JSON.stringify(value), base64. */
export function encryptForServer(value) {
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(AES_KEY, 'utf8'), Buffer.from(AES_IV, 'utf8'));
  return Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]).toString('base64');
}

/**
 * Smartschool Webtop parent/student client (webtop.smartschool.co.il).
 * Auth is a cookie session on webtopserver.smartschool.co.il; every call is a JSON POST.
 */
export class Smartschool {
  constructor(config, { log = () => {} } = {}) {
    if (!config.username || !config.password) {
      throw new Error('smartschool config needs username and password.');
    }
    this.config = config;
    this.log = log;
    this.current = null;
  }

  async session({ force = false } = {}) {
    if (!force && this.current) return this.current;
    let stored = force ? null : loadSession('smartschool');
    if (!stored) stored = await this.login();
    this.current = { ...stored, jar: new CookieJar(stored.cookies) };
    return this.current;
  }

  headers(rememberMe = false) {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      language: 'he',
      rememberMe: rememberMe ? encryptForServer('remeberMe') : '0',
      Origin: 'https://webtop.smartschool.co.il',
      Referer: 'https://webtop.smartschool.co.il/',
    };
  }

  async login({ otpCode } = {}) {
    const jar = new CookieJar();
    const uniqueId = deviceId();
    const pending = loadSession('smartschool-2fa');

    if (otpCode) {
      if (!pending) throw new Error('No pending Smartschool 2FA login. Run "login" first.');
      this.log('smartschool: submitting one-time code');
      const res = await request(`${API}api/user/LoginByOneTimePassword`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({
          Code: Number(otpCode),
          Guid: pending.guid,
          UniqueId: uniqueId,
          deviceDataJson: '{}',
          rememberMe: true,
        }),
        jar: new CookieJar(pending.cookies),
      });
      const data = res.json?.data?.data || res.json?.data;
      if (!res.json?.status || !data) {
        throw new Error(`smartschool 2FA failed (HTTP ${res.status}): ${(res.text || '').slice(0, 300)}`);
      }
      const stored = { cookies: { ...pending.cookies, ...jar.cookies }, user: data };
      saveSession('smartschool', stored);
      return stored;
    }

    this.log('smartschool: logging in');
    await request(`${API}api/user/LogOut`, { method: 'POST', headers: this.headers(), body: '{}', jar });
    const res = await request(`${API}api/user/LoginByUserNameAndPassword`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        UserName: this.config.username,
        Password: this.config.password,
        Data: encryptForServer(`${this.config.username}0`),
        captcha: null,
        RememberMe: true,
        BiometricLogin: '',
        UniqueId: uniqueId,
        deviceDataJson: '{}',
      }),
      jar,
    });
    if (res.status !== 200 || !res.json) {
      throw new Error(`smartschool login failed (HTTP ${res.status}): ${(res.text || '').slice(0, 300)}`);
    }
    if (!res.json.status) {
      // Never retry on a wrong password: after two failures the site demands a reCAPTCHA.
      throw new Error(
        `smartschool rejected the login: ${res.json.errorDescription || res.json.message || 'check username/password'}`,
      );
    }
    if (res.json.message === 'get2FA') {
      const token = res.json.data?.token || '';
      saveSession('smartschool-2fa', { cookies: jar.cookies, guid: String(token).split(',')[0], raw: res.json.data });
      throw new Error(
        'smartschool asked for a one-time code (2FA). Check your phone/email, then run: school.mjs login smartschool --otp <code>',
      );
    }
    const stored = { cookies: jar.cookies, user: res.json.data };
    saveSession('smartschool', stored);
    return stored;
  }

  async post(path, body = {}, { retry = true } = {}) {
    const session = await this.session();
    const res = await request(`${API}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      jar: session.jar,
    });
    const unauthorized =
      res.status === 401 ||
      res.status === 403 ||
      (res.json && res.json.status === false && /authori|token|login/i.test(res.json.errorDescription || ''));
    if (unauthorized && retry) {
      this.log(`smartschool: session rejected on ${path}, re-logging in`);
      await this.session({ force: true });
      return this.post(path, body, { retry: false });
    }
    if (res.status >= 400) {
      throw new Error(`smartschool POST ${path} failed (HTTP ${res.status}): ${(res.text || '').slice(0, 300)}`);
    }
    if (res.json && res.json.status === false) {
      throw new Error(`smartschool ${path} returned status=false: ${res.json.errorDescription || res.json.message || ''}`);
    }
    return res.json?.data ?? res.json;
  }

  async accounts() {
    return (await this.post('api/user/GetMultipleUsersForUser', {})) || [];
  }

  async settings() {
    if (!this._settings) this._settings = await this.post('api/PupilCard/GetSettingsList', {});
    return this._settings;
  }

  async kids() {
    // Sequential on purpose: a stale session would otherwise trigger two parallel re-logins.
    const accounts = await this.accounts();
    const settings = await this.settings();
    const school = accounts[0]?.school_name || null;
    const institutionCode = accounts[0]?.institutionCode || null;
    return (settings.children || []).map((c) => ({
      provider: 'smartschool',
      name: `${c.firstName} ${c.lastName}`.trim(),
      school,
      institutionCode,
      studentId: c.id,
      classCode: c.classCode,
      classNum: c.classNum,
      classLabel: c.classCode != null ? `${c.classCode}-${c.classNum}` : null,
      lastName: c.lastName,
      firstName: c.firstName,
    }));
  }

  // ---- messages ---------------------------------------------------------

  async inbox({ page = 1, unreadOnly = false, search = '' } = {}) {
    const rows = (await this.post('api/messageBox/GetMessagesInbox', {
      PageId: page,
      LabelId: 0,
      HasRead: unreadOnly ? 0 : null,
      SearchQuery: search,
    })) || [];
    return {
      total: rows[0]?.count ?? rows.length,
      page,
      messages: rows.map((m) => ({
        messageId: m.messageId,
        subject: m.subject,
        from: `${m.student_F_name || ''} ${m.student_L_name || ''}`.trim(),
        sendTime: m.sendingDate,
        unread: !m.hasRead,
        hasAttachments: !!m.filesWereAttached,
      })),
    };
  }

  async message(messageId) {
    const data = await this.post('api/messageBox/GetMessagesInboxData', {
      MessageId: messageId,
      FilterId: 0,
      IsInbox: true,
      hasRead: null,
    });
    const m = data?.messageData || {};
    return {
      messageId,
      subject: m.subject,
      from: `${m.privateName || ''} ${m.lastName || ''}`.trim(),
      sendTime: m.sendingDate,
      body: htmlToText(m.messageContent),
      recipientsCount: m.totalRecipientsCount,
      files: (m.filesList || []).map((f, index) => ({
        index,
        fileName: f.fileName,
        size: f.fileSize ? `${Math.round(f.fileSize.size)} ${f.fileSize.sizeName}` : null,
        fileUrl: f.fileUrl,
      })),
    };
  }

  async downloadFile(fileUrl, fileName, outDir) {
    const session = await this.session();
    const res = await request(fileUrl, {
      headers: { Referer: 'https://webtop.smartschool.co.il/', Origin: 'https://webtop.smartschool.co.il' },
      jar: session.jar,
      binary: true,
    });
    if (res.status !== 200) throw new Error(`smartschool download failed (HTTP ${res.status})`);
    const saved = writeDownload(outDir, fileName, res.buffer);
    return { saved, bytes: res.buffer.length, contentType: res.headers.get('content-type') };
  }

  // ---- student card -----------------------------------------------------

  async yearName(year) {
    try {
      const range = await this.post('api/user/GetYearRange', {});
      const list = Array.isArray(range) ? range : range?.years || [];
      const hit = list.find((y) => Number(y.value ?? y.year ?? y.id) === Number(year));
      return hit?.year || hit?.name || hit?.title || String(year);
    } catch {
      return String(year);
    }
  }

  /** moduleId 4 = lesson events (absence, lateness, remarks), 5 = out-of-class events, 33 = private hours. */
  async events(kid, { moduleId = 4, periodId = null } = {}) {
    const settings = await this.settings();
    const year = settings.currentStudyYear;
    const divisions = settings.divisionsList || [];
    const period = periodId ? divisions.find((d) => d.division_id === Number(periodId)) : divisions.find((d) => d.isCurrent) || divisions[0];
    return this.post('api/PupilCard/GetPupilDiciplineEvents', {
      weekIndex: 0,
      viewType: 0,
      studyYear: year,
      studyYearName: await this.yearName(year),
      studentID: kid.studentId,
      studentName: `${kid.lastName} ${kid.firstName}`,
      classCode: kid.classCode,
      periodID: period?.division_id ?? -1,
      periodName: period?.division_name ?? '',
      moduleID: moduleId,
    });
  }

  async dashboard() {
    return this.post('api/dashboard/InitDashboard', {});
  }

  /** Daily/weekly schedule from the dashboard. Many schools leave this empty and send the timetable as a PDF. */
  async schedule(kid, { date = new Date(), view = 'weekly' } = {}) {
    const raw = await this.post('api/dashboard/WeeklySchedualeForToday', {
      InstitutionCode: kid.institutionCode,
      SelectedDate: date.toISOString(),
      View: view,
      spaceId: 0,
      language: 'he',
    });
    const data = raw?.data || raw || {};
    const events = data.events || {};
    const hours = (events.hours || [])
      .filter((h) => h.fromTime && h.fromTime !== ':')
      .map((h) => ({ hour: h.hour, from: h.fromTime, to: h.toTime }));
    return {
      startDate: events.startDate || null,
      view,
      hours,
      lessons: events.events || [],
      note: events.events ? undefined : 'The school has not published a timetable in Webtop. Look for a timetable PDF in messages.',
    };
  }

  async homework(kid) {
    return this.post('api/dashboard/GetHomeWork', {
      id: kid.studentId,
      ClassCode: kid.classCode,
      ClassNumber: kid.classNum,
    });
  }

  async dashboardGrades(kid) {
    return this.post('api/dashboard/GetGrades', { id: kid.studentId, ClassCode: kid.classCode });
  }

  async notifications() {
    return this.post('api/Notification/GetNotificationList', { id: 0 });
  }

  async fileRepository(kid, folderId = 0) {
    const init = await this.post('api/files/InitData', {});
    const list = await this.post('api/files/GetFilesList', { FolderId: folderId, StudentId: kid.studentId, spaceId: 0 });
    return { init, list };
  }
}
