# sol-integrate

Cloudflare Worker that writes form submissions into a client's third-party integrations, then optionally requests a confirmation email from [sol-notify](https://github.com/solsoftware-co/sol-notify). First pass: **Mailchimp** (add/update audience member). Google Sheets follows in SOL-10.

```bash
cp .dev.vars.example .dev.vars
npm install
npm run dev   # http://localhost:8789
npm test
```

See [CLAUDE.md](./CLAUDE.md) for the request contract, flow, and environments. Bruno collection in `bruno/`.
