# Interview Tracker

This puts your interviews and online-assessment (OA) deadlines from all your Gmail inboxes onto one Google Calendar, and your phone alerts you **1 day before** and **1 hour before** each one.

- **Interviews** appear at the right time in your time zone, with the meeting link as the location and the original email linked in the description.
- **OA deadlines** appear as `OA due: Company` at the moment the assessment expires.
- **Reschedules** move the existing event. **Cancellations** and **submitted OAs** remove it.
- **No upkeep.** It checks every 10 minutes from Google's servers, so your computer doesn't need to be on.

## How it works

A small Google Apps Script runs inside each Gmail account. Every 10 minutes it searches for new emails that mention interviews or assessments and sends each one to an AI model (free, through [Groq](https://groq.com)). The model reads it and says what to add, move, or remove. The script then updates a shared **Interviews** calendar that your main account owns.

Your phone gets the alerts because the calendar has default notifications of 1 day and 1 hour. Those defaults cover every event, including events added from your other accounts.

**Time zones:** an event's time comes from the most reliable source the email has:

1. **A calendar invite.** Most interview confirmations include one, from Google, Outlook, Teams or a scheduling tool. The event uses the invite's exact time and time zone.
2. **A relative OA deadline** such as "expires in 72 hours". It's counted from the moment the email arrived.
3. **Otherwise, the email text.** The model reports the time exactly as written, along with its time zone (for example `2:00 PM` + `America/Los_Angeles`).

In every case Google Calendar does the conversion, including daylight saving, and your phone shows the time in whatever zone you're in. If an email doesn't say a time zone, the event uses your home time zone and its title starts with ⚠️ so you know to check it. Each event's description says where its time came from.

## Setup (about 10 minutes)

Use the Google account whose calendar is on your phone as your **main account**.

### 1. Get a free Groq API key

Sign up at [console.groq.com](https://console.groq.com) (no credit card), open **API Keys**, click **Create API Key**, and copy the key. It starts with `gsk_`. See [Cost and limits](#cost-and-limits).

### 2. Main account

1. Signed in as your main account, open [script.google.com](https://script.google.com) and click **New project**. Name it `Interview Tracker`.
2. Delete everything in `Code.gs` and paste in the contents of [`apps-script/Code.js`](apps-script/Code.js).
3. In the left sidebar, click **+** next to **Services**, choose **Google Calendar API**, and click **Add**.
4. Click **Project Settings** (the gear icon). Under **Script properties**, add:
   - `GROQ_API_KEY`: your key
   - `SHARE_WITH`: your other Gmail addresses, separated by commas, e.g. `me.work@gmail.com, me.old@gmail.com`
5. Go back to the editor, choose `setup` in the function menu at the top, and click **Run**. Google will ask for permission: pick your account, then **Advanced → Go to Interview Tracker (unsafe)** (it's your own script), then **Allow**.

The log at the bottom shows the **Calendar ID**. Copy it, because the other accounts need it. Setup also runs a first sync over the last 14 days, so interviews you've already scheduled get added.

### 3. Each other Gmail account

Repeat steps 1–5 above while signed in to that account, with one change in step 4. Add these Script properties instead:

- `GROQ_API_KEY`: the same key
- `CALENDAR_ID`: the ID from your main account

### 4. Your phone

Install the **Google Calendar** app, sign in with your main account, and allow notifications. Make sure the **Interviews** calendar is turned on. Apple's Calendar app uses its own alert settings, so use Google's app to get these alerts.

### 5. Outlook (optional)

In Outlook.com, go to **Settings → Mail → Forwarding**, forward to one of your Gmail addresses, and tick **Keep a copy of forwarded messages**. Those emails then go through the same process.

## Day to day

You shouldn't need to do anything. Some details:

- **Scheduling links** ("pick a time on Calendly") aren't added. The confirmation email you get after you book something is.
- **OAs with no deadline** aren't added, because there's nothing to be alerted about.
- **Something went wrong?** Google emails you if a run fails, for example a bad API key or an email it couldn't read after 3 tries. The email names the message to add by hand. Each run's log is under **Executions** in the script editor, with lines like `Added "Stripe: Phone Screen" at Wed 2026-10-14 17:00 America/New_York (calendar invite, America/Los_Angeles)`.
- **Duplicates:** if a company sends a real Google Calendar invite to your main account, Google may also put it on your primary calendar. That's Gmail's own behaviour and separate from this script.

## Cost and limits

**Groq (default): free.** It uses `openai/gpt-oss-120b`. The free plan has rate limits instead of a bill: about 1,000 requests and 200,000 tokens a day, shared by every account that uses your Groq key. That's roughly 40–60 emails a day. Only emails that mention interview or assessment keywords are sent (`SEARCH_TERMS` in the code), and each one only once. If the daily limit runs out, the script pauses and carries on when it resets, so nothing is lost. With a lot of matching email, the first 14-day sync can take a day or two to catch up. Your exact limits are on [console.groq.com/settings/limits](https://console.groq.com/settings/limits). Groq doesn't keep the content of requests by default.

**Claude (optional): cheap, with no daily limits.** If you'd rather use Anthropic's Claude Haiku 5.5, put an `ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com/settings/keys) in Script properties instead of `GROQ_API_KEY`. As a rough estimate, it costs well under a tenth of a cent per email, so a $5 credit lasts thousands of emails. If both keys are set, Groq is used.

To try a different model, set a `MODEL` script property, e.g. `qwen/qwen3.8-27b` on Groq or `claude-sonnet-5-5` on Claude.

## Changing things

Settings are at the top of `Code.gs` in `CONFIG`: alert times, calendar name, default models, how often it checks, and the search keywords. If you change the alert times or calendar name, run `setup` again in the main account. Set the `HOME_TIMEZONE` script property (e.g. `America/Chicago`) if your Google Calendar's time zone isn't where you live.

To update the code, paste the new `Code.js` over `Code.gs` in each account. Your settings live in Script properties, so they're kept.

## Development

`apps-script/Code.js` is the whole app. `apps-script/appsscript.json` is its manifest, for anyone using [clasp](https://github.com/google/clasp). The tests run the script in Node against fake Gmail, Calendar, Groq and Claude services, with no dependencies:

```sh
npm test
```
