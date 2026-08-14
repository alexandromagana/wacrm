"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import { Sidebar } from "@/components/layout/sidebar";
import { IconRailSidebar } from "@/components/layout/icon-rail-sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.
//
// Two nav surfaces, one per breakpoint: the icon rail on lg+ and the
// labelled drawer below it. The rail is only 64px wide and always
// visible, so the desktop collapse toggle the full-width sidebar used
// to need is gone along with it.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Drawer state — mobile only. The rail on lg+ is always visible.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // Both nav surfaces are mounted at once (each hidden at the other's
  // breakpoint), so these counts are subscribed here and passed down
  // rather than read inside each one. Both hooks open a realtime
  // channel under a fixed name; calling them twice makes the second
  // `.on()` land after the first `.subscribe()`, which throws.
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <IconRailSidebar
        totalUnread={totalUnread}
        unreadNotifications={unreadNotifications}
      />
      <Sidebar
        open={sidebarOpen}
        onClose={closeSidebar}
        totalUnread={totalUnread}
        unreadNotifications={unreadNotifications}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
