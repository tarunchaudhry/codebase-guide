import { Header } from './_components/Header';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <Header />
        {children}
      </body>
    </html>
  );
}
