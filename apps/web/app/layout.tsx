import type { Metadata } from 'next';
import './globals.css';
import { AppHeader } from '@/components/AppHeader';
import { AppFooter } from '@/components/AppFooter';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://ai-pushup-couch.vercel.app'),
  title: 'ai-pushup-couch — Better form. A stronger you.',
  description:
    'Real-time push-up form analysis using on-device pose estimation. Counts reps, detects form faults, and scores your technique.',
  applicationName: 'ai-pushup-couch',
};

export const viewport = {
  themeColor: '#0B1117',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="flex min-h-screen flex-col bg-base">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-base-raised focus:px-4 focus:py-2 focus:text-sm focus:text-ink"
        >
          Skip to content
        </a>
        <AppHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <AppFooter />
      </body>
    </html>
  );
}
