import { defineAuth } from '@aws-amplify/backend';

/**
 * Nobody signs in. This auth resource is kept because its Cognito *identity pool*
 * hands every visitor temporary guest credentials, which is how the site talks to the
 * database without a login. (Self sign-up stays off; no user accounts are used.)
 */
export const auth = defineAuth({
  loginWith: { email: true },
});
