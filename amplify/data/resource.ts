import { type ClientSchema, a, defineData } from '@aws-amplify/backend';

/**
 * One DynamoDB table holds the whole Rotation Tracker dataset, split into sections:
 *
 *   main/root                    statuses, weekOf, skillsCatalog, … (+ list of workspaces)
 *   main/ws~speed                one item per workspace (builders, rotation, goals, notes…)
 *   main/ws~fa~faShift           big CSV imports (quarterly / faShift / binScan) get their own item
 *   main/ws~fa~faShift#<rev>#<n> chunk items, only when a section is too big for one item
 *
 * `data` is gzip+base64 JSON. No login: everyone who opens the site shares the same
 * warehouse-wide data (guest access through the Cognito identity pool, no key to expire).
 */
const schema = a.schema({
  TrackerDoc: a
    .model({
      data: a.string(),
      parts: a.integer(),
      rev: a.integer(),
      updatedBy: a.string(),     // browser-session id (used to ignore our own echoes)
      updatedByUser: a.string(), // unused without logins (kept so existing items stay valid)
    })
    .authorization((allow) => [allow.guest()]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: { defaultAuthorizationMode: 'identityPool' },
});
