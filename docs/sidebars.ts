import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  mainSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Domains',
      items: [
        'domains/custom-domain-setup',
        'domains/default-subdomain',
      ],
    },
    {
      type: 'category',
      label: 'Hotel Onboarding',
      items: [
        'onboarding/invite-codes',
        'onboarding/setup-wizard',
      ],
    },
    {
      type: 'category',
      label: 'Booking Engine',
      items: [
        'booking-engine/design-studio',
        'booking-engine/room-management',
        'booking-engine/billing',
      ],
    },
  ],
};

export default sidebars;
