"use client";

/**
 * The activity rail. It lives on the left of every screen in the app and holds the
 * one thing you always want within reach: what actually happened. Roll it open to
 * read the conversation and the settled trades, fold it away when you want the
 * room. It reads straight from the shared app data, so whatever a trade did on one
 * screen shows up here the moment the indexer sees it, no matter where you are.
 */

import { useAppData } from "@/providers/AppData";
import { ActivityFeed } from "./ActivityFeed";

export function Sidebar({ open }: { open: boolean }) {
  const { activity } = useAppData();

  return (
    <aside className={`app-sidebar ${open ? "is-open" : "is-closed"}`} aria-hidden={!open}>
      <div className="app-sidebar-inner">
        <ActivityFeed activity={activity.data} loading={activity.loading} />
      </div>
    </aside>
  );
}
