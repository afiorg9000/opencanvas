# Open Canvas

Infinite canvas with **email + code** login and a **local SQLite database**. No cloud accounts, no magic links.

## Run

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173).

- First sign-in with an email + code **creates** your account
- Later, use the **same email + code**
- Your board autosaves into `data/canvas.db` on this machine

## Stack

- Vite frontend
- Express API on port `8787`
- SQLite via `better-sqlite3`

## Live site (Netlify)

The published site saves to the cloud (Netlify Blobs), so the same board shows up on every device:

- Sign in with your email + code. The first sign-in creates the account; only the owner of the published board (or emails listed in the `ALLOWED_EMAILS` environment variable) can create one.
- On your first cloud sign-in the board starts from `public/snapshot.json`; after that the cloud copy is the board.
- After 8 wrong codes, sign-in is paused for 15 minutes.

The `npm run dev` app on your computer still keeps its own board in `data/canvas.db`, separate from the cloud one. To publish that board as the starting point for a fresh cloud account:

```bash
npm run export-board
git add public
git commit -m "Update board"
git push
```

`export-board` writes `public/snapshot.json` and copies images into `public/api/assets`. Don't commit `data/` — it holds login codes and session tokens.
