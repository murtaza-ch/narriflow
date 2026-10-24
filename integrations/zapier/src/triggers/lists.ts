import { defineTrigger } from 'zapier-platform-core';
import { api } from '../api';
import { PLATFORM_LABELS, type BrandProfilesResult, type SocialAccountsResult } from '../types';

/**
 * Hidden triggers that fill dynamic dropdowns. Input fields refer to them as
 * `brand_profile_list.id.name` and `social_account_list.id.name`.
 */

export const brandProfileList = defineTrigger({
  key: 'brand_profile_list',
  noun: 'Brand Profile',
  display: {
    label: 'New Brand Profile',
    description: 'Lists Brand Profiles for dropdowns.',
    hidden: true,
  },
  operation: {
    type: 'polling',
    perform: async (z, bundle) => {
      const { data } = await api<BrandProfilesResult>(z, bundle, { path: '/brand-profiles' });
      return data.profiles.map((profile) => ({
        id: profile.brandProfileId,
        name: profile.isDefault ? `${profile.name} (default)` : profile.name,
      }));
    },
    sample: { id: '00000000-0000-4000-8000-000000000050', name: 'Acme (default)' },
  },
});

export const socialAccountList = defineTrigger({
  key: 'social_account_list',
  noun: 'Social Account',
  display: {
    label: 'New Social Account',
    description: 'Lists connected social accounts for dropdowns.',
    hidden: true,
  },
  operation: {
    type: 'polling',
    perform: async (z, bundle) => {
      const { data } = await api<SocialAccountsResult>(z, bundle, { path: '/social-accounts' });
      // Expired and revoked accounts can't take a post until someone reconnects them.
      return data.accounts
        .filter((account) => account.status === 'active')
        .map((account) => ({
          id: account.accountId,
          name: `${account.displayName} (${PLATFORM_LABELS[account.platform] ?? account.platform})`,
        }));
    },
    sample: { id: '00000000-0000-4000-8000-000000000060', name: 'Acme Shorts (TikTok)' },
  },
});
