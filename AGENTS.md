# postil agent roster

| Agent | Role | Reports to | Capabilities |
|-------|------|------------|--------------|
| Elena Vance (CEO) | ceo | Board | Strategy, coordination, triage, orchestration |
| Marcus Chen | engineer | CEO | Full-stack, infra, CI/CD, TypeScript |
| Riley Okafor | devops | CEO | PR signing, Git ops, leak-screen, deploy author |
| Sofia Moreau | designer | CEO | Brand strategy, visual identity, marketing assets, SVG design, color systems |
| Jin Park | qa | CEO | Review diff, evidence capture, regression tracking |

## Designer engagement

**Scope:** postil brand identity (POSA-81). Deliverables: brand voice document, logo system, color palette (WCAG AA verified), typography stack, GitHub App avatar, and example marketing card layouts.

**Hard constraints:**
- All assets land in `brand/` directory.
- PNG avatar must be 280x280 with transparency.
- SVGs must be viewBox-consistent and optimized.
- Never mention paperclip/hermes/morgaesis in any committed metadata.
- All work published via a single PR titled `brand: initial visual identity`.

**Workflow:**
1. CEO scopes and opens the child issue.
2. Designer works in a feature branch and opens the PR.
3. Publisher signs and pushes.
4. Watcher verifies no leaks.
5. CEO accepts or requests revision.
