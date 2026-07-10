import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Postil — AI review that can block a merge.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Brand palette
const IVORY = "#F7F5F1";
const CHARCOAL = "#1B2329";
const GATE = "#64745C";
const STONE = "#E3DED8";
const RUST = "#C24A2A";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: IVORY,
          padding: "72px 80px",
          fontFamily: "Georgia, serif",
        }}
      >
        {/* Top row: mark + wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          {/* Gate motif: nested arches rendered as SVG */}
          <svg width="58" height="79" viewBox="0 0 144 196">
            <path
              fill={GATE}
              fillRule="evenodd"
              d="M 0 196 L 0 90 C 0 62 28 27 72 0 C 116 27 144 62 144 90 L 144 196 Z M 16 181 L 16 94 C 16 73 39 47 72 23 C 105 47 128 73 128 94 L 128 181 Z"
            />
            <path
              fill={CHARCOAL}
              fillRule="evenodd"
              d="M 33 164 L 33 90 C 33 74 50 56 72 42 C 94 56 111 74 111 90 L 111 164 Z M 46 164 L 46 93 C 46 82 58 66 72 55 C 86 66 98 82 98 93 L 98 164 Z"
            />
            <path
              fill={CHARCOAL}
              fillRule="evenodd"
              d="M 52 164 L 52 106 C 52 94 62 82 72 76 C 82 82 92 94 92 106 L 92 164 Z M 61 164 L 61 109 C 61 104 64 101 68 100 L 68 164 Z M 76 164 L 76 100 C 80 101 83 104 83 109 L 83 164 Z"
            />
          </svg>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span
              style={{
                display: "flex",
                fontSize: 40,
                fontWeight: 600,
                color: CHARCOAL,
                letterSpacing: -1,
              }}
            >
              Postil
            </span>
            <span
              style={{
                fontSize: 15,
                fontFamily: "monospace",
                letterSpacing: 4,
                color: GATE,
              }}
            >
              REVIEW GATE
            </span>
          </div>
        </div>

        {/* Headline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 76,
              fontWeight: 600,
              color: CHARCOAL,
              lineHeight: 1.05,
              letterSpacing: -2,
            }}
          >
            <span>AI review that</span>
            <span>can block a merge.</span>
          </div>
          <div style={{ fontSize: 30, color: GATE, fontFamily: "Helvetica, sans-serif" }}>
            Silent on clean PRs. A hard gate on what matters.
          </div>
        </div>

        {/* Footer strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            borderTop: `2px solid ${STONE}`,
            paddingTop: 24,
            fontFamily: "monospace",
            fontSize: 22,
            color: CHARCOAL,
          }}
        >
          <span style={{ color: RUST, fontWeight: 700 }}>postil/gate</span>
          <span style={{ color: STONE }}>·</span>
          <span style={{ color: GATE }}>postil/review</span>
          <span style={{ color: STONE }}>·</span>
          <span>silence is a feature</span>
          <span style={{ marginLeft: "auto", color: GATE }}>postil.dev</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
