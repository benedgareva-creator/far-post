import { redirect } from "next/navigation";
import { consumeLoginLink } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function confirm(formData: FormData) {
  "use server";
  const userId = await consumeLoginLink(String(formData.get("token") ?? ""));
  if (!userId) redirect("/login?ok=0&m=" + encodeURIComponent("That link has expired or was already used. Ask for a new one."));
  redirect("/welcome");
}

// A button press is needed so email scanners that preview links do not use them up.
export default async function Verify({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <div style={{ maxWidth: 420, margin: "60px auto", textAlign: "center" }}>
      <h1>Welcome back</h1>
      <p className="sub">Tap below to finish signing in.</p>
      <form action={confirm} className="mt">
        <input type="hidden" name="token" value={token ?? ""} />
        <button className="btn block" type="submit">Sign in to Far Post</button>
      </form>
    </div>
  );
}
