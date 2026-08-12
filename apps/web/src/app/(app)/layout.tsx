"use client";

/**
 * The frame every in-app screen hangs in. It owns the two pieces of chrome that
 * never change as you move around: the navbar up top and the activity rail down
 * the left. The rail remembers whether you left it open. Everything below wires
 * itself to the shared app data mounted right here, so the price on the copilot
 * screen and the price on the faucet screen are the same number read once.
 */

import { useEffect, useState } from "react";
import { AppDataProvider } from "@/providers/AppData";
import { AppNavbar } from "@/components/AppNavbar";
import { Sidebar } from "@/components/Sidebar";

const SIDEBAR_KEY = "roque-sidebar-open";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Restore the rail the way it was left. Default open, so a first-time visitor
  // sees the activity rather than a blank margin.
  useEffect(() => {
    const saved = window.localStorage.getItem(SIDEBAR_KEY);
    if (saved === "closed") setSidebarOpen(false);
  }, []);

  const toggleSidebar = () => {
    setSidebarOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(SIDEBAR_KEY, next ? "open" : "closed");
      } catch {
        // A blocked storage just means the rail forgets between visits.
      }
      return next;
    });
  };

  return (
    <AppDataProvider>
      <AppNavbar onToggleSidebar={toggleSidebar} />
      <div className={`app-body ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
        <Sidebar open={sidebarOpen} />
        <main className="app-main">{children}</main>
      </div>
    </AppDataProvider>
  );
}
