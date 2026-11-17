# Add email + password logins (domain-restricted) to Manager Board

This converts the tracker from **guest / no-login** to **email + password accounts**, where sign-up is **restricted to an allowed email domain** (default `amazon.com` — change it, see step 1).

## What's in this folder

```
amplify/auth/resource.ts                NEW  – email login + preSignUp trigger
amplify/auth/pre-sign-up/resource.ts    NEW  – Lambda definition + ALLOWED_DOMAINS
amplify/auth/pre-sign-up/handler.ts     NEW  – rejects disallowed email domains
amplify/auth/resource.ts (updated)      NEW  – + 12-hour session note
amplify/backend.ts.PATCH.md             EDIT – 12-hour token expiry (CDK)
amplify/data/resource.ts.PATCH.md       EDIT – guest() -> authenticated()
src/cloud.js.PATCH.md                   EDIT – userPool auth + login gate + 12h cap
scripts/build.mjs.PATCH.md              EDIT – copy login.html + outputs to dist/
login.html                              NEW  – sign-in / sign-up / reset UI

```

Files ending `.PATCH.md` describe surgical edits to YOUR existing files (I can't see their exact current contents, so they're written as "find X, replace with Y"). The rest are drop-in new files.

## Steps

1. **Pick your allowed domain.** Edit `amplify/auth/pre-sign-up/resource.ts` and set `ALLOWED_DOMAINS` (comma-separated, no `@`). Example: `ALLOWED_DOMAINS: 'amazon.com'` or `'amazon.com,example.com'`. Also update the placeholder in `login.html` (`you@amazon.com`).
2. **Copy the new files into the repo**, preserving the folder layout above.
3. **Apply the three **`.PATCH.md`** edits** to your existing `amplify/data/resource.ts`, `src/cloud.js`, and `scripts/build.mjs`.
4. **Remove guest access.** The new `amplify/auth/resource.ts` has no guest config, and the data patch switches to `userPool` — together they drop the guest identity pool. (If you had any `allow.guest()` elsewhere, change it too.)
5. **Test locally (optional but recommended):**``` npm install npx ampx sandbox # provisions the user pool + preSignUp Lambda npm run build npx serve dist # open [http://localhost:3000/login.html](http://localhost:3000/login.html)

```Try
6. **Deploy:** `git add . && git commit -m "Add domain-restricted email login" && git push`. Amplify rebuilds (~5-8 min) and provisions Cognito + the Lambda.

## Important notes

- **Existing data is safe.** You're only changing *who can reach* the data and *how the client authenticates* — the DynamoDB table and its contents are untouched. (Point-in-time recovery stays on.)
- **First user:** after deploy, go to `/login.html`, choose *Sign up*, use an allowed-domain email, confirm with the emailed code, then sign in.
- **Email verification:** on by default (users get a code). To skip it, uncomment the two `autoConfirm*` lines in `handler.ts`.
- **Managing users / revoking access:** AWS Console → Cognito → your user pool → Users. You can disable or delete any account there.
- **This is NOT corporate SSO.** It's self-managed accounts gated to your domain. If you later want true Amazon SSO, that requires registering the app with your corporate IdP (needs IT) — this setup can be upgraded to that.
- I can't push to GitHub or run the AWS deploy for you — you commit & deploy.

```

```


```

