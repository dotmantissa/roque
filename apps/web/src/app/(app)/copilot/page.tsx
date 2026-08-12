import type { Metadata } from "next";
import { TradeScreen } from "@/components/TradeScreen";

export const metadata: Metadata = {
  title: "Copilot",
  description: "Trade by talking, and sign every move yourself.",
};

export default function CopilotPage() {
  return <TradeScreen mode="copilot" />;
}
