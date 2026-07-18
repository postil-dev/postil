"use client";

import { initializePaddle } from "@paddle/paddle-js";
import { useState } from "react";

interface CheckoutResponse {
  transactionId: string;
  clientToken: string;
  environment: "sandbox" | "production";
}

export function BillingCheckoutButton({ slug }: { slug: string }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  async function openCheckout() {
    if (state === "loading") return;
    setState("loading");
    try {
      const response = await fetch(
        `/api/orgs/${encodeURIComponent(slug)}/billing/checkout`,
        { method: "POST", headers: { accept: "application/json" } },
      );
      if (!response.ok) throw new Error("checkout unavailable");
      const checkout = (await response.json()) as Partial<CheckoutResponse>;
      if (
        typeof checkout.transactionId !== "string" ||
        typeof checkout.clientToken !== "string" ||
        (checkout.environment !== "sandbox" &&
          checkout.environment !== "production")
      ) {
        throw new Error("checkout response malformed");
      }
      const paddle = await initializePaddle({
        token: checkout.clientToken,
        environment: checkout.environment,
      });
      if (!paddle) throw new Error("checkout library unavailable");
      paddle.Checkout.open({
        transactionId: checkout.transactionId,
        settings: {
          displayMode: "overlay",
          theme: "light",
          showAddTaxId: true,
          successUrl: `${window.location.origin}/orgs/${encodeURIComponent(slug)}/billing?checkout=submitted`,
        },
      });
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        className="btn-primary text-xs disabled:cursor-wait disabled:opacity-60"
        disabled={state === "loading"}
        onClick={openCheckout}
      >
        {state === "loading"
          ? "Opening secure checkout…"
          : "Continue after trial"}
      </button>
      {state === "error" && (
        <p role="alert" className="mt-2 text-xs text-rust">
          Checkout could not start. Try again in a moment.
        </p>
      )}
    </div>
  );
}

export function BillingPortalButton({ slug }: { slug: string }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  async function openPortal() {
    if (state === "loading") return;
    setState("loading");
    try {
      const response = await fetch(
        `/api/orgs/${encodeURIComponent(slug)}/billing/portal`,
        { method: "POST", headers: { accept: "application/json" } },
      );
      if (!response.ok) throw new Error("portal unavailable");
      const payload = (await response.json()) as { url?: unknown };
      if (typeof payload.url !== "string") {
        throw new Error("portal response malformed");
      }
      const url = new URL(payload.url);
      if (url.protocol !== "https:") throw new Error("portal URL is invalid");
      window.location.assign(url.toString());
    } catch {
      setState("error");
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        className="btn-secondary text-xs disabled:cursor-wait disabled:opacity-60"
        disabled={state === "loading"}
        onClick={openPortal}
      >
        {state === "loading" ? "Opening billing…" : "Manage billing"}
      </button>
      {state === "error" && (
        <p role="alert" className="mt-2 text-xs text-rust">
          Billing could not open. Try again in a moment.
        </p>
      )}
    </div>
  );
}
