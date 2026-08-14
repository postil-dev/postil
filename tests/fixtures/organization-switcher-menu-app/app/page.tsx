import { OrganizationSwitcherMenu } from "../../../../src/components/organization-switcher-menu";

export default function OrganizationSwitcherMenuFixture() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Reports / runatlas-is</p>
          <h1 className="serif-display mt-2 text-3xl">RunAtlas Iceland</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <OrganizationSwitcherMenu
            currentSlug="runatlas-is"
            organizations={[
              { slug: "runatlas-is", name: "RunAtlas Iceland" },
              { slug: "postil-dev", name: "Postil Development" },
            ]}
          />
          <a href="/notifications" className="btn-secondary text-xs">
            Notifications
          </a>
          <a href="/billing" className="btn-secondary text-xs">
            Billing
          </a>
          <a href="/settings" className="btn-secondary text-xs">
            Settings
          </a>
          <a href="/pricing" className="btn-secondary text-xs">
            Pro plan
          </a>
        </div>
      </div>
    </main>
  );
}
