import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';

const backend = defineBackend({ auth, data });

// Invite-only: nobody can create their own account from the sign-in screen.
const { cfnUserPool } = backend.auth.resources.cfnResources;
cfnUserPool.adminCreateUserConfig = { allowAdminCreateUserOnly: true };

// Point-in-time recovery on the tracker table — lets you restore to any second
// in the last 35 days if data ever gets clobbered.
backend.data.resources.cfnResources.amplifyDynamoDbTables['TrackerDoc'].pointInTimeRecoveryEnabled = true;
