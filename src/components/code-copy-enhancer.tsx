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
    const feedbackTimers = new Map<HTMLButtonElement, number>();

    const enhance = (pre: HTMLPreElement) => {
      if (
        pre.dataset.copyEnhanced === "true" ||
        pre.classList.contains("ev-diff")
      ) {
        return;
      }

      const code = Array.from(pre.children).find(
        (child): child is HTMLElement => child.tagName === "CODE",
      );
      if (!code || !pre.parentNode) return;

      const terminalTitlebar = pre.previousElementSibling;
      const hasTerminalTitlebar =
        pre.parentElement?.classList.contains("terminal") === true &&
        terminalTitlebar instanceof HTMLElement &&
        terminalTitlebar.classList.contains("terminal-titlebar");

      const wrapper = document.createElement("div");
      wrapper.className = `code-copy-wrapper code-copy-wrapper--${
        hasTerminalTitlebar ? "terminal" : "bare"
      }`;

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

      button.addEventListener("click", async () => {
        const copied = await copyText(code.textContent ?? "");
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
      });

      pre.dataset.copyEnhanced = "true";
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.append(pre, status);

      if (hasTerminalTitlebar) {
        terminalTitlebar.append(button);
      } else {
        wrapper.append(button);
      }
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
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      feedbackTimers.forEach((timer) => window.clearTimeout(timer));
      document
        .querySelectorAll<HTMLElement>(".code-copy-wrapper")
        .forEach((wrapper) => {
          const pre = wrapper.querySelector<HTMLPreElement>(":scope > pre");
          if (!pre || !wrapper.parentNode) return;

          if (wrapper.classList.contains("code-copy-wrapper--terminal")) {
            wrapper.previousElementSibling
              ?.querySelector<HTMLElement>(":scope > .code-copy-button")
              ?.remove();
          }

          delete pre.dataset.copyEnhanced;
          wrapper.parentNode.replaceChild(pre, wrapper);
        });
    };
  }, []);

  return null;
}
