import Navbar from './Sidebar';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg-primary">
      <Navbar />
      <main className="pt-[52px] min-h-screen">
        <div className="max-w-[1440px] mx-auto px-6 md:px-10 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
