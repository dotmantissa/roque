"use client";

/**
 * The provider stack. Theme sits on the outside so the whole tree, Privy's own
 * modal included, follows the light or dark choice. Privy runs in external
 * wallet mode only: no embedded wallets, no email, no funny business. A person
 * connects the wallet they already trust, and Roque asks it to sign. We hand
 * Privy our brand blue and the Sepolia chain so its modal looks like it belongs
 * to this app rather than a bolt on.
 */

import { PrivyProvider } from "@privy-io/react-auth";
import { sepolia } from "viem/chains";
import { ThemeProvider, useTheme } from "./ThemeProvider";
import { ToastProvider } from "@/components/Toaster";
import { ChessCanvas } from "@/components/ChessCanvas";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

function WalletLayer({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  // Force Privy to remount when the theme actually changes, since its SDK
  // only reads `appearance.theme` once at mount and does not react to prop
  // updates on its own.
  const privyKey = theme;

  if (!APP_ID) {
    // Without an app id the wallet features cannot work, but the market panels
    // and interpreter still read fine, so we do not blow up the whole page.
    if (typeof window !== "undefined") {
      console.warn("NEXT_PUBLIC_PRIVY_APP_ID is not set; wallet features are off.");
    }
    return <>{children}</>;
  }

  return (
    <PrivyProvider
      key={privyKey}
      appId={APP_ID}
      config={{
        loginMethods: ["wallet"],
        embeddedWallets: { createOnLogin: "off" },
        defaultChain: sepolia,
        supportedChains: [sepolia],
        appearance: {
          theme: theme === "dark" ? "dark" : "light",
          accentColor: theme === "dark" ? "#2f6bff" : "#003dad",
          walletList: ["metamask", "rainbow", "coinbase_wallet", "wallet_connect", "detected_wallets"],
          showWalletLoginFirst: true,
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ChessCanvas />
      <ToastProvider>
        <WalletLayer>{children}</WalletLayer>
      </ToastProvider>
    </ThemeProvider>
  );
}
