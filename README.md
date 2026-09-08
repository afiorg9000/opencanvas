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
