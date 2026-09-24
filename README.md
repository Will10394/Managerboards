# Rotation Tracker — Amplify + DynamoDB

The same Rotation Tracker, hosted on AWS Amplify, with one shared warehouse-wide
dataset in DynamoDB instead of each browser's localStorage. Managers sign in
(Cognito, invite-only), edits save automatically, and other open sessions pick up
changes live.

```
app/rotation-tracker.html   your standalone export, unmodified (build adds the hooks)
src/cloud.js                sign-in screen, AppSync calls, "Synced / Sign out" pill
src/sync.js                 sectioning, gzip, chunking, diffed saves, conflict + live merge
amplify/                    backend: Cognito auth + TrackerDoc model (DynamoDB)
scripts/build.mjs           builds dist/index.html + dist/cloud.js
test/                       node unit tests (npm test), browser e2e (test/e2e.py)
```

## Deploy (first time)

1. **Push this folder to a Git repo** (GitHub, CodeCommit, GitLab or Bitbucket).
2. **AWS console → Amplify → Create new app → pick the repo + branch.** Amplify
   detects `amplify.yml` and this as a Gen 2 app. If asked for a service role, let it
   create one. Deploy. First build takes ~5–8 min (it creates Cognito, AppSync and the
   DynamoDB table).
3. **Create accounts:** Amplify console → your app → *Authentication* → *Users* →
   *Create user* (email + temporary password). Self sign-up is disabled, so this is the
   only way in. On first sign-in each person sets their own password.
4. **Move your existing data up:** sign in *on the computer/browser where you've been
   using the standalone tracker*. The cloud is empty, so it asks whether to upload this
   browser's saved data — click **OK**. Everyone else then gets that data.
   (Sign in somewhere else first and you'll get the sample data; if that happens, reset
   isn't needed — just do step 4 from the right browser *before anyone edits*, or ask
   me for a one-off import.)

## Updating the tracker

Keep developing the standalone file as usual. To ship a new version, replace
`app/rotation-tracker.html` with the new export and push. The build re-applies the
cloud hooks automatically and **fails the build** (instead of shipping a local-only
tracker) if `loadData()` / `save()` ever change shape enough that the hooks can't
find their anchors. The standalone file keeps working offline exactly as before —
the hooks do nothing when `cloud.js` isn't present.

## How data is stored

One DynamoDB table (`TrackerDoc-…`), items keyed like:

| id | holds |
|---|---|
| `main/root` | statuses, weekOf, skills catalog, … |
| `main/ws~speed`, `main/ws~fa`, … | one per workspace: builders, rotation, goals, notes, contributions |
| `main/ws~fa~faShift`, `main/ws~speed~quarterly`, `main/ws~fa~binScan` | CSV imports, stored on their own |
| `…#<rev>#<n>` | chunks, only when a section is bigger than ~150 KB compressed |

Payloads are gzip+base64 JSON. Only sections that actually changed are written, so
moving one builder doesn't re-upload a quarterly CSV. Point-in-time recovery is on
(restore the table to any second in the last 35 days).

**Two managers editing at once:** edits to different workspaces never collide. If two
people edit the *same* workspace within a second of each other, the later save wins for
that workspace and the other person's screen updates to match (logged in the console).

## Local development

```bash
npm install
npx ampx sandbox          # personal cloud backend; writes amplify_outputs.json
npm run build             # dist/index.html + dist/cloud.js
npx serve dist            # or any static server
npm test                  # sync-engine unit tests
```

Cost at warehouse scale is effectively the free tier / pennies per month
(on-demand DynamoDB, AppSync per-request, Amplify Hosting).
