import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { exportBackup } from "@/lib/services/admin";
import { logAdmin } from "@/lib/services/alerts";

export const dynamic = "force-dynamic";

// Ben's weekly backup download (Admin > Health).
export async function GET() {
  const user = await currentUser();
  if (!user?.is_admin || !user.second_factor) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const data = await exportBackup();
  await logAdmin(user.id, "download backup", {});
  return new NextResponse(JSON.stringify(data), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="far-post-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
}
