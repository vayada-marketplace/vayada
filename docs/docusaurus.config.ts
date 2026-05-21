import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'vayada Docs',
  tagline: 'Internal documentation for the vayada team',
  favicon: 'img/favicon.ico',

  url: 'https://docs.vayada.com',
  baseUrl: '/',

  organizationName: 'FlamurMaliqi',
  projectName: 'vayada',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/',
          editUrl: 'https://github.com/FlamurMaliqi/vayada/tree/main/docs/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'vayada Docs',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'mainSidebar',
          position: 'left',
          label: 'Guides',
        },
        {
          href: 'https://admin.booking.vayada.com',
          label: 'Booking Admin',
          position: 'right',
        },
        {
          href: 'https://pms.vayada.com',
          label: 'PMS',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Guides',
          items: [
            { label: 'Getting Started', to: '/' },
            { label: 'Custom Domains', to: '/domains/custom-domain-setup' },
          ],
        },
        {
          title: 'Platform',
          items: [
            { label: 'Booking Admin', href: 'https://admin.booking.vayada.com' },
            { label: 'PMS', href: 'https://pms.vayada.com' },
            { label: 'Marketplace Admin', href: 'https://admin.vayada.com' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} vayada. Internal use only.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
