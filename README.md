# sol-integrate

Internal Cloudflare Worker that performs one integration write — first pass: **Mailchimp** (add/update an audience member) — and returns its outcome. Its only caller is **Sol Gate**, the public form front door (SOL-38), over a service binding; staging and production have no public URL. Google Sheets follows in SOL-10.

```bash
cp .dev.vars.example .dev.vars
npm install
npm run dev   # http://localhost:8789 — Mailchimp writes are mocked locally
npm test
```

See [CLAUDE.md](./CLAUDE.md) for the request contract, flow, and environments.
