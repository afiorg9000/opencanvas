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

## Publish to Netlify

Netlify builds from GitHub, but your board lives only in `data/canvas.db` on this computer. To update the live site:

```bash
npm run export-board
git add public
git commit -m "Update board"
git push
```

`export-board` writes `public/snapshot.json` and copies images into `public/api/assets`. Don't commit `data/` — it holds login codes and session tokens.
