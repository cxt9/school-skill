---
name: school
description: Read-only access to the user's children's school data on Mashov (משו"ב, web.mashov.info) and Smartschool Webtop (webtop.smartschool.co.il). Lists kids, reads teachers' messages and attachments, downloads files, and fetches timetable, grades, homework, attendance/behavior events, lesson history and notifications. Use whenever the user asks about their kids' school, a teacher's message, the schedule, grades, homework, absences, or wants a school attachment saved.
---

# School (Mashov + Smartschool)

Everything runs through one CLI that prints JSON:

```bash
node scripts/school.mjs <command> [args] [--kid <name>] [--take N] [--page N] [--unread] [--out DIR]
```

Run it from this skill's directory (the directory containing this SKILL.md). Log lines go to stderr, data to stdout.

## Workflow

1. Start with `kids` once per conversation. It returns every child with `provider`, `school`, `classLabel` and ids. Use the child's first name as `--kid`.
2. Pick the command for the question (table below). When a question spans children, run the command once per child.
3. Answer from the JSON. Message bodies are already plain text. Dates are ISO strings in Israel local time. Hebrew day numbers: 1 = Sunday.
4. To save an attachment: `message <id>` to see the `files` list, then `download <messageId> <fileIdOrIndex>`. Report the saved path.

## Commands

| Question | Command |
|---|---|
| Which kids / which school | `kids` |
| New or recent messages from school | `messages --kid X [--unread] [--take 30]` (Smartschool pages with `--page N`, 10 per page) |
| Read one message | `message <id> --kid X` (Mashov id = conversationId, Smartschool id = messageId) |
| Save an attachment | `download <messageId> <fileId or index> --kid X [--out DIR]` (default `~/Downloads/school`) |
| Timetable / what lessons today | `timetable --kid X` (Mashov: full week; Smartschool: today's schedule) |
| Grades | `grades --kid X` (Mashov only) |
| Homework | `homework --kid X` |
| Absences, lateness, remarks | `behavior --kid X` |
| What was taught (lesson log) | `lessons --kid X` (Mashov) |
| Files shared with the student | `files --kid X` |
| Platform notifications | `notifications --kid X` |
| Anything else the site shows | `raw mashov students/<childGuid>/<endpoint>` or `raw smartschool api/<Controller>/<Action> '<json body>'` |

## Platform notes

- Mashov: a parent with kids in two schools has one session per school code (semel). The CLI handles this by itself; never mix a child's guid with another school's session.
- Mashov endpoints available under `students/<guid>/`: timetable, grades, homework, behave, lessons/history, files, lessonsCount, bagrut/grades, notifications. Mail: `mail/inbox/conversations?skip=0&take=20`, `mail/conversations/<id>`.
- Smartschool: opening a message with `message` marks it as read on the site, exactly like opening it in the app. Say so if the user cares about unread state.
- Smartschool elementary schools often expose only lesson events, out-of-class events and private hours in the student card. `grades`/`homework` answering `allowToViewThis: false` means the school disabled that module for parents, and `timetable` with an empty `lessons` list means the school never published one in Webtop (look for a PDF in messages instead).
- Config and sessions live under `~/.config/school-skill/`. In a sandboxed environment (for example Claude Cowork) where the home folder is not the user's real one, set `SCHOOL_SKILL_HOME` to a folder the user connected that contains their `config.json`, e.g. `SCHOOL_SKILL_HOME=/path/to/connected/folder/school-skill-config node scripts/school.mjs kids`. Node 20+ and outbound HTTPS to mashov.info and smartschool.co.il are required; if either is missing, say so instead of retrying.
- Sessions are cached in `<SCHOOL_SKILL_HOME>/sessions/`. On 401/403 the CLI logs in again once. A wrong password is never retried (Smartschool shows a reCAPTCHA after two failures).
- If Smartschool answers with a 2FA request, tell the user to check for the one-time code and run `login smartschool --otp <code>`. Never ask the user to paste the code into chat if the CLI can take it directly from them.

## Boundaries

- Read-only. There is no command that sends, replies, signs, or deletes anything, and none should be added ad hoc through `raw`.
- Credentials live only in `~/.config/school-skill/config.json` (owned by the user). Never print passwords, cookies or CSRF tokens in the conversation.
- The data is about minors. Quote only what is needed to answer the question, and do not compile it elsewhere.

## Troubleshooting

- `Missing config file`: the user has not created `~/.config/school-skill/config.json` yet. Point them to README.md in this skill.
- `no child matches`: run `kids --refresh` and check the spelling; `--kid` also matches a school name.
- Empty arrays are usually real (nothing posted yet this year), not errors. Check `notifications` or `messages` before concluding the site is down.
- To inspect a failing call, run it with `raw` to see the untouched response.
