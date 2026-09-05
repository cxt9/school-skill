# school-skill

A Claude skill that reads your children's school data from **Mashov** (משו"ב) and **Smartschool Webtop**, so you can ask questions like "what did the teacher send this week?", "what does Noa have on Tuesday?" or "save the timetable PDF". Works in Claude Code and Claude Cowork.

Read-only. Zero dependencies. Node 20 or newer.

## What you can ask

Once installed, just ask Claude Code or Cowork in plain language, in Hebrew or English. For example:

<div dir="rtl" align="right">
<ul>
<li>מה מערכת השעות של נועה ליום שלישי?</li>
<li>איזה מורה שלח הודעה השבוע? תסכם לי את ההודעות שלא נקראו של שני הילדים.</li>
<li>תשמור את אישור ההורים לטיול שהמחנכת צירפה לתיקיית ההורדות שלי.</li>
<li>האם יונתן איחר או נעדר החודש?</li>
<li>מה למדו במתמטיקה בשבוע שעבר, ויש שיעורי בית?</li>
</ul>
</div>

Claude picks the right child and platform, runs the CLI, and answers from the data. Nothing is ever sent back to the school.

## Setup

### 1. Credentials (once, for both Claude Code and Cowork)

Clone this repo, then create the config directory and copy the example:

```bash
git clone https://github.com/cxt9/school-skill.git && cd school-skill
mkdir -p ~/.config/school-skill && cp config.example.json ~/.config/school-skill/config.json && chmod 600 ~/.config/school-skill/config.json
```

Edit `~/.config/school-skill/config.json` with your own credentials. Delete the section for a platform you do not use.

- `mashov.username` is the ID number you type on the Mashov login page, `semel` is the school code shown on the login page, `year` is the school year label (the year in which the school year ends; leave it out to compute it automatically). A parent with kids in several Mashov schools only needs one `semel`; the other schools are discovered automatically.
- `smartschool.username` / `password` are your Webtop login.

Verify from a terminal (Node 20 or newer):

```bash
node scripts/school.mjs kids
```

You should see every child, their school and class. Nothing else needs to be configured; sessions are cached and refreshed automatically.

### 2a. Claude Code

Skills in `~/.claude/skills` are available in every Claude Code session (terminal, desktop app, IDE extensions). A symlink keeps the skill in sync with this repo:

```bash
ln -s "$(pwd)" ~/.claude/skills/school
```

Start a new Claude Code session and ask a school question. Claude loads the skill by itself; there is no command to run.

### 2b. Claude Cowork

Cowork does not read `~/.claude/skills`. Its skills come from your claude.ai account, so the skill has to be uploaded once:

1. Build the upload package (a zip whose top-level folder is named `school`):

   ```bash
   mkdir -p /tmp/school-upload/school && cp -R SKILL.md README.md LICENSE config.example.json scripts /tmp/school-upload/school/ && (cd /tmp/school-upload && zip -r school.zip school) && open /tmp/school-upload
   ```

2. In claude.ai open Settings, then Capabilities, then Skills, choose Upload skill and pick `school.zip`.
3. Restart Cowork (or wait for it to sync). The skill appears in Cowork's skills list as `school`.

Cowork runs skills in its own sandbox with its own home folder, so it cannot see `~/.config/school-skill`. Give it the config through a connected folder:

1. Create a dedicated folder, for example `~/Documents/school-skill-config`, and copy your `config.json` into it. Use a folder that holds nothing else, because Cowork can read everything in a connected folder.
2. Connect that folder in Cowork (the folder picker in the Cowork sidebar).
3. Ask your question and mention the folder once, for example: "Use the school skill with the config in my connected school-skill-config folder. What does Noa have on Tuesday?" The skill reads the folder path through the `SCHOOL_SKILL_HOME` environment variable and caches sessions there too.

Requirements inside Cowork's sandbox: Node 20 or newer and outbound HTTPS to `web.mashov.info` and `webtopserver.smartschool.co.il`. If Cowork reports that `node` is missing or the sites time out, the sandbox on your machine does not provide them; use the skill from Claude Code instead.

### Claude chat (claude.ai)

Uploading the skill also lists it in Claude chat, but chat runs skills in a cloud sandbox with no access to your credentials or to the school sites, so it cannot answer school questions. Use Claude Code or Cowork.

### Updating

Claude Code follows this repo through the symlink, so `git pull` is enough. For Cowork, rebuild the zip and upload it again; the new version replaces the old one.

## How login works

- **Mashov**: the CLI posts to the same `/api/login` the web app uses, stores the session cookie and CSRF token in `~/.config/school-skill/sessions/`, and logs in again only when the site rejects the session. Kids in different schools get one session each; switching is automatic.
- **Smartschool**: the CLI posts to `LoginByUserNameAndPassword` with the same request the web client sends (the client-side AES envelope is reproduced). A wrong password is never retried because the site adds a reCAPTCHA after two failures. If your school enforces a one-time code, run `node scripts/school.mjs login smartschool --otp <code>` after receiving it.

Nothing is stored anywhere except your own machine. `node scripts/school.mjs logout` deletes the cached sessions.

## Commands

Run `node scripts/school.mjs --help` for the full list, or read [SKILL.md](SKILL.md).

## Privacy

The data concerns minors. The skill only reads what your account can already see, never writes back to the platforms, and keeps credentials and sessions in `~/.config/school-skill/` (or the folder you connected to Cowork) with owner-only permissions. Do not commit that directory or your `config.json`, and do not connect the config folder to anything other than Cowork.
