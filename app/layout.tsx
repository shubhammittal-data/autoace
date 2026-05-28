export const metadata = {
  title: 'AutoAce — Retell ↔ Xtime Bridge',
  description: 'Voice-AI service scheduling middleware',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          margin: 0,
          background: '#0b0d10',
          color: '#e6e8eb',
        }}
      >
        {children}
      </body>
    </html>
  );
}
