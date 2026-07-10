"use client";

import { useEffect } from "react";

const COPIED_FEEDBACK_MS = 1500;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();

    try {
      return document.execCommand("copy");
    } finally {
      textarea.remove();
    }
  }
}

export function CodeCopyEnhancer() {
  useEffect(() => {
    let disposed = false;
    const feedbackTimers = new Map<HTMLButtonElement, number>();
    type Enhancement = {
      pre: HTMLPreElement;
      mode: "bare" | "terminal";
      button: HTMLButtonElement;
      buttonParent: HTMLElement;
      status: HTMLSpanElement;
      statusParent: HTMLElement;
      onClick: () => Promise<void>;
    };
    const enhancements = new Set<Enhancement>();

    const cleanupEnhancement = (enhancement: Enhancement) => {
      const {
        pre,
        mode,
        button,
        buttonParent,
        status,
        statusParent,
        onClick,
      } = enhancement;
      button.removeEventListener("click", onClick);

      const timer = feedbackTimers.get(button);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        feedbackTimers.delete(button);
      }
      if (button.parentNode === buttonParent) {
        buttonParent.removeChild(button);
      }
      if (status.parentNode === statusParent) {
        statusParent.removeChild(status);
      }
      // Always drop the marker, connected or not: a disconnected <pre> that
      // React later re-inserts must not carry a stale marker that blocks
      // re-enhancement.
      if (pre.dataset.copyEnhanced === mode) {
        delete pre.dataset.copyEnhanced;
      }

      enhancements.delete(enhancement);
    };

    const enhance = (pre: HTMLPreElement) => {
      if (
        pre.hasAttribute("data-copy-enhanced") ||
        pre.classList.contains("ev-diff")
      ) {
        return;
      }

      const code = Array.from(pre.children).find(
        (child): child is HTMLElement => child.tagName === "CODE",
      );
      if (!code) return;

      const terminalTitlebar = pre.previousElementSibling;
      const hasTerminalTitlebar =
        pre.parentElement?.classList.contains("terminal") === true &&
        terminalTitlebar instanceof HTMLElement &&
        terminalTitlebar.classList.contains("terminal-titlebar");

      const mode = hasTerminalTitlebar ? "terminal" : "bare";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy-button";
      button.setAttribute("aria-label", "Copy code");
      button.innerHTML = `
        <svg class="code-copy-icon code-copy-icon-default" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="6.5" y="6.5" width="9" height="9" rx="1.5" />
          <path d="M13.5 6.5V5A1.5 1.5 0 0 0 12 3.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5" />
        </svg>
        <svg class="code-copy-icon code-copy-icon-success" viewBox="0 0 20 20" aria-hidden="true">
          <path d="m4.5 10.5 3.25 3.25L15.5 6" />
        </svg>
      `;

      const status = document.createElement("span");
      status.className = "code-copy-status";
      status.setAttribute("aria-live", "polite");
      status.setAttribute("aria-atomic", "true");

      const onClick = async () => {
        const copied = await copyText(code.textContent ?? "");
        if (disposed || !button.isConnected) return;

        button.focus({ preventScroll: true });

        if (!copied) {
          status.textContent = "Copy failed";
          return;
        }

        const previousTimer = feedbackTimers.get(button);
        if (previousTimer !== undefined) window.clearTimeout(previousTimer);

        button.dataset.copied = "true";
        status.textContent = "Copied";
        const timer = window.setTimeout(() => {
          delete button.dataset.copied;
          status.textContent = "";
          feedbackTimers.delete(button);
        }, COPIED_FEEDBACK_MS);
        feedbackTimers.set(button, timer);
      };
      button.addEventListener("click", onClick);

      pre.dataset.copyEnhanced = mode;

      if (hasTerminalTitlebar) {
        terminalTitlebar.append(status, button);
      } else {
        pre.append(status, button);
      }

      const parent = hasTerminalTitlebar ? terminalTitlebar : pre;
      enhancements.add({
        pre,
        mode,
        button,
        buttonParent: parent,
        status,
        statusParent: parent,
        onClick,
      });
    };

    const enhanceWithin = (root: ParentNode) => {
      if (root instanceof HTMLPreElement) enhance(root);
      root.querySelectorAll<HTMLPreElement>("pre").forEach(enhance);
    };

    enhanceWithin(document);

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) enhanceWithin(node);
        });
      });

      // A re-render can strip the injected controls while keeping the marked
      // <pre> in place; treat a missing button or status like a removed block
      // and re-enhance the survivor.
      Array.from(enhancements)
        .filter(
          ({ pre, button, status }) =>
            !pre.isConnected || !button.isConnected || !status.isConnected,
        )
        .forEach((enhancement) => {
          const { pre } = enhancement;
          cleanupEnhancement(enhancement);
          if (pre.isConnected) enhance(pre);
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      disposed = true;
      observer.disconnect();
      feedbackTimers.forEach((timer) => window.clearTimeout(timer));
      feedbackTimers.clear();
      Array.from(enhancements).forEach(cleanupEnhancement);
    };
  }, []);

  return null;
}
