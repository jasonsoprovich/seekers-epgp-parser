# Seekers EPGP — officer app

A small desktop app for Seekers of Souls officers: reads your EverQuest log
file to capture raid attendance and loot bids, then submits them to the
guild site. No installer — download the `.exe` and run it.

## Installing

1. Go to the [latest release](https://github.com/jasonsoprovich/seekers-epgp-parser/releases/latest)
   and download `seekers-epgp-parser.exe`.
2. Run it. Windows will likely show a **SmartScreen warning** — see below.
3. In the app's Settings tab, click **Get an app key**, sign in on the site,
   and paste the key back in.

### "Windows protected your PC"

You'll see this the first time you run the `.exe` (and possibly after each
update), because it isn't signed with a paid code-signing certificate —
Windows treats any unsigned executable as unrecognized regardless of how
trustworthy it actually is. To run it anyway:

1. Click **More info** on the SmartScreen dialog.
2. Click **Run anyway**.

This is a one-time click-through per downloaded copy of the app, not a sign
of anything actually wrong with the file. If your guild ever wants to make
this warning go away entirely, that requires buying a code-signing
certificate — nobody's decided that's worth it yet given how small and
low-stakes this app is.

## Staying up to date

The app checks for a new release on startup and shows a banner if one's
available. Click **Update & restart** to download it, verify it, and
relaunch automatically — no need to repeat the SmartScreen click-through
manually each time. If that ever fails (e.g. the app is installed
somewhere Windows won't let it write to), use the **Download it** link in
the same banner to grab and run the new `.exe` by hand instead.

## For developers

See `CLAUDE.md`.
