import React from "react";

import { Tooltip } from "@calcom/ui/components/tooltip";

type KasperoPriceComponentProps = {
  displaySymbol: boolean;
  price: number;
  formattedPrice: string;
};

export function KasperoPriceComponent({ displaySymbol, price, formattedPrice }: KasperoPriceComponentProps) {
    const [fiatValue, setFiatValue] = React.useState<string>("");

  React.useEffect(() => {
    (async () => {
      try {
        const response = await fetch("https://kasperopay.com/api/store/price/kas");
        if (!response.ok) throw new Error("Rate fetch failed");
        const data = await response.json();
        const kasToUsd = data.kasToUsd;
        if (!kasToUsd || typeof kasToUsd !== "number" || kasToUsd <= 0) {
          throw new Error("Invalid rate data");
        }
        const usdValue = price * kasToUsd;
        setFiatValue(`≈ $${usdValue.toFixed(2)} USD`);
      } catch {
        setFiatValue("");
        }
      })();
  }, [price]);

  return (
    <Tooltip content={fiatValue}>
      <div className="inline-flex items-center justify-center">
        {displaySymbol && <KaspaSymbol className="h-4 w-4 mr-1" />}
        {(price / 100).toFixed(2)} KAS
      </div>
    </Tooltip>
  );
}

// Simple Kaspa symbol component
function KaspaSymbol({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
    </svg>
  );
}
