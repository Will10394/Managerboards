import { defineAuth } from '@aws-amplify/backend';

/**
 * Email + password sign-in via Cognito.
 * Self sign-up is switched OFF in backend.ts — accounts are created by an admin
 * (Amplify console → Authentication → Users), so only people you add can see the data.
 */
export const auth = defineAuth({
  loginWith: { email: true },
});
