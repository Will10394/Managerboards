# Restrict Manager Board to the Amazon network (AWS WAF IP allow-list)

Goal: only requests coming from **Amazon corporate IP ranges** can reach the site. Everyone else gets a 403 at the edge — before the page or any data loads.

This is the strongest of the network options and layers on top of the login + `authenticated()` API lockdown you're already adding. Keep all three: WAF keeps outsiders off the door, login gives per-person identity, the API rule stops anyone who slips past the page from hitting the data directly.

---

## Before you start — the one dependency you must get from IT

You need the **Amazon corporate egress CIDR ranges** (the public IP blocks that corp laptops / VPN appear to come from). I can't look these up — ask your network / IT security team for:

> "The corporate egress / VPN public CIDR ranges I should allow-list on an internet-facing AWS WAF web ACL."

They'll give you one or more blocks like `A.B.C.0/24`, `D.E.F.0/20`, etc. Write them down — you'll paste them into the IP set in Step 1.

> Note: WAF IP sets are IP-version-specific. If corp also hands you IPv6 ranges, make a second IP set for IPv6 and add a matching rule.

---

## Prerequisite — Amplify tier

Attaching a WAF web ACL to an Amplify app requires **Amplify Hosting's WAF feature** (available on the app's firewall settings; may require the paid/ advanced hosting option). If your app is on the free tier and the firewall option is greyed out, that tier upgrade is the only cost here.

---

## Step 1 — Create the IP set

1. AWS Console → **WAF & Shield** → **IP sets** → **Create IP set**.
2. **Region:** this must match where you'll attach it:- If attaching via **Amplify Hosting firewall** → create the IP set in the **same region as your Amplify app**.
- If attaching via **CloudFront** (Option B) → create it in **Global (CloudFront)** / us-east-1.
3. Name: `amazon-corp-allow`.
4. **IP version:** IPv4.
5. **Addresses:** paste the corp CIDR ranges from IT, one per line.
6. Create.

## Step 2 — Create the Web ACL with a default-block posture

1. WAF & Shield → **Web ACLs** → **Create web ACL** (same region as Step 1).
2. Name: `manager-board-acl`.
3. **Resource type:** match your attach method (Amplify = regional app; CloudFront = CloudFront distributions).
4. **Rules → Add rule → Add my own rules → IP set rule:**- Rule name: `allow-corp`.
- IP set: `amazon-corp-allow`.
- Action: **Allow**.
5. **Default web ACL action: Block.** ← this is the key setting. Anything that is NOT in the corp IP set is blocked.
6. (Optional) add AWS Managed Rules (e.g. Core rule set) for general hardening.
7. Create.

## Step 3 — Attach the Web ACL to the app

**If using Amplify Hosting's firewall (simplest):**

1. Amplify Console → your app → **Hosting → Firewall** (a.k.a. "Web Application Firewall").
2. Enable it and **associate the **`manager-board-acl` web ACL.
3. Save. Amplify deploys the association (a minute or two).

**If using CloudFront (Option B):**

1. In the web ACL, **Associated AWS resources → Add association →** pick your CloudFront distribution that fronts the Amplify app.

## Step 4 — Test

1. **On corp network / VPN:** open the site → loads normally.
2. **Off corp network** (phone on cellular, or disconnect VPN): open the site → you should get a **403 Forbidden** at the edge.
3. If corp access itself gets 403, the CIDR list from IT is incomplete or you used the wrong region for the IP set — re-check with IT and Step 1's region note.

---

## How this stacks with the rest

| Layer | What it stops | Where |
| --- | --- | --- |
| **WAF IP allow-list** (this doc) | Anyone off the corp network reaching the site at all | Edge, before load |
| **Cognito login** (email + domain) | Unknown people on-network; gives per-person identity/audit | App |
| **12-hour token expiry** | Stale/forgotten sessions | App/Cognito |
| `allow.authenticated()`** on data** | Direct hits to the AppSync/DynamoDB endpoint that bypass the page | API |

Removing any one layer leaves a gap — e.g. WAF alone still lets any on-network person see 44 coworkers' names and leave status, which is why you keep the login too.

## Caveats (be honest with yourself about these)

- **WAF filters by source IP only.** It can't tell a "corp laptop" from any device sharing that egress IP. That's fine for "keep the public internet out," but it is not device-trust.
- **Accuracy depends entirely on the CIDR list from IT.** If corp adds new egress ranges later, you must add them to the IP set or those users get 403.
- **Cost:** WAF has a small monthly web-ACL fee + per-request fee (pennies at this scale), plus any Amplify tier upgrade needed to enable the firewall.
- **This is self-managed network restriction, not corporate zero-trust/SSO.** If security requires true device + identity trust, that's an IT-owned private-hosting/VPN path (Option D).

