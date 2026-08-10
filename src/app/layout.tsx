import type { Metadata } from 'next';
import { Archivo, Martian_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';

const archivo = Archivo({
  subsets: ['latin'],
  variable: '--font-archivo',
  display: 'swap',
});

const martian = Martian_Mono({
  subsets: ['latin'],
  variable: '--font-martian',
  weight: ['300', '400', '500', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'AgentFlow — AI agent workflow builder',
  description:
    'Multi-tenant workflow engine for chaining AI agent steps, on nhost + Hasura + PostgreSQL.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${martian.variable}`}>
      <body className="min-h-screen antialiased">
        <Providers>
          <div className="relative z-10">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
