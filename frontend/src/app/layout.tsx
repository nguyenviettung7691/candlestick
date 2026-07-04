import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Candlestick Dashboard',
  description: 'Hydrate-then-Stream dashboard for market indicator tracking.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
