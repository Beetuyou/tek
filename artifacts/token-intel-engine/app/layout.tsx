export const metadata = {
  title: 'Token Intel Engine',
  description: 'Discover memecoins linked to social media posts',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0d1117', color: '#c9d1d9' }}>
        {children}
      </body>
    </html>
  );
}
