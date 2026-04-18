import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'EB Ops Visualizer — JARVIS',
  description: 'Real-time operations dashboard for Everything Bagel Partners',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: '#0a0a0a', overflow: 'hidden' }}>
        {children}
      </body>
    </html>
  );
}
