# school-skill

A Claude Code skill that reads your children's school data from **Mashov** (משו"ב) and **Smartschool Webtop**, so you can ask questions like "what did the teacher send this week?", "what does Avshalom have on Tuesday?" or "save the timetable PDF".

Read-only. Zero dependencies. Node 20 or newer.

## What you can ask

Once installed, just ask Claude Code in plain language (Hebrew or English):

- "What does Noa have on Tuesday?" or "מה מערכת השעות של נועה ליום שלישי?"
- "Did any teacher send something this week? Summarize the unread messages for both kids."
- "Save the trip permission form the homeroom teacher attached to my Downloads folder."
- "Was Yonatan marked late or absent this month?"
- "What was taught in math last week, and is there homework?"

Claude picks the right child and platform, runs the CLI, and answers from the data. Nothing is ever sent back to the school.

## Setup

1. Create the config directory and copy the example:

   ```bash
   mkdir -p ~/.config/school-skill && cp config.example.json ~/.config/school-skill/config.json && chmod 600 ~/.config/school-skill/config.json
   ```

2. Edit `~/.config/school-skill/config.json` with your own credentials. Delete the section for a platform you do not use.
   - `mashov.username` is the ID number you type on the Mashov login page, `semel` is the school code shown on the login page, `year` is the school year label (the year in which the school year ends; leave it out to compute it automatically).
   - `smartschool.username` / `password` are your Webtop login.

3. Install the skill for Claude Code (symlink keeps it in sync with this repo):

   ```bash
   ln -s "$(pwd)" ~/.claude/skills/school
   ```

4. Test:

   ```bash
   node scripts/school.mjs kids
   ```

## How login works

- **Mashov**: the CLI posts to the same `/api/login` the web app uses, stores the session cookie and CSRF token in `~/.config/school-skill/sessions/`, and logs in again only when the site rejects the session. Kids in different schools get one session each; switching is automatic.
- **Smartschool**: the CLI posts to `LoginByUserNameAndPassword` with the same request the web client sends (the client-side AES envelope is reproduced). A wrong password is never retried because the site adds a reCAPTCHA after two failures. If your school enforces a one-time code, run `node scripts/school.mjs login smartschool --otp <code>` after receiving it.

Nothing is stored anywhere except your own machine. `node scripts/school.mjs logout` deletes the cached sessions.

## Commands

Run `node scripts/school.mjs --help` for the full list, or read [SKILL.md](SKILL.md).

## Privacy

The data concerns minors. The skill only reads what your account can already see, never writes back to the platforms, and keeps credentials and sessions in `~/.config/school-skill/` with owner-only permissions. Do not commit that directory or your `config.json`.
