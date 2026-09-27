import { Check, Copy, X } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";

interface TokenIdentityProps {
  symbol: string;
  name?: string | null;
  mint?: string;
  iconUrl?: string | null;
  compact?: boolean;
}

type CopyState = "idle" | "copied" | "failed";

async function writeToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();

  if (!copied) {
    throw new Error("Clipboard copy was rejected");
  }
}

export function TokenIdentity({ symbol, name, mint, iconUrl, compact = false }: TokenIdentityProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<number | null>(null);
  const showImage = Boolean(iconUrl && iconUrl !== failedUrl);
  const displayName = name?.trim() || (mint ? `${mint.slice(0, 6)}…${mint.slice(-4)}` : symbol);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const copyMint = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!mint) return;

    try {
      await writeToClipboard(mint);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
    }
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1_500);
  };

  return (
    <span className={`token-identity ${compact ? "token-identity--compact" : ""}`} title={mint}>
      <span className="token-identity__icon" aria-hidden="true">
        {showImage ? (
          <img src={iconUrl!} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(iconUrl!)} />
        ) : (
          <i>{symbol.slice(0, 2).toUpperCase()}</i>
        )}
      </span>
      <span className="token-identity__copy">
        <strong>{symbol}</strong>
        <small>{displayName}</small>
      </span>
      {mint ? (
        <button
          type="button"
          className={`token-identity__copy-mint is-${copyState}`}
          title={copyState === "copied" ? `Copied ${mint}` : `Copy token address: ${mint}`}
          aria-label={copyState === "copied" ? `${symbol} token address copied` : `Copy ${symbol} token address`}
          onClick={copyMint}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {copyState === "copied" ? <Check size={12} /> : copyState === "failed" ? <X size={12} /> : <Copy size={12} />}
          {copyState !== "idle" ? (
            <span className="token-identity__copy-status" role="status">
              {copyState === "copied" ? "Copied" : "Copy failed"}
            </span>
          ) : null}
        </button>
      ) : null}
    </span>
  );
}
