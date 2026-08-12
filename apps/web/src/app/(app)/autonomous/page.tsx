import type { Metadata } from "next";
import { TradeScreen } from "@/components/TradeScreen";

export const metadata: Metadata = {
  title: "Autonomous",
  description: "Let Roque trade on your words, inside limits you set and can pull back any time.",
};

export default function AutonomousPage() {
  return <TradeScreen mode="autonomous" />;
}
