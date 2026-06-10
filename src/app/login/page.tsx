export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <article className="container-page py-24 max-w-md">
      <h1 className="font-serif text-4xl mb-3">Sign in</h1>
      <p className="text-[color:var(--color-charcoal-soft)] mb-8">
        Postil signs you in with the same GitHub account you'd install the App from. We
        don't ask for a password.
      </p>
      <form action="/api/auth/sign-in/social" method="POST" className="space-y-3">
        <input type="hidden" name="provider" value="github" />
        <input type="hidden" name="callbackURL" value="/reports" />
        <button type="submit" className="btn-primary w-full justify-center">
          Continue with GitHub
        </button>
      </form>
    </article>
  );
}
