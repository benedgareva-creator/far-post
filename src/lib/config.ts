// Settings read from environment variables (.env locally, Render's private settings in production).
const env = (k: string, d = "") => (process.env[k] ?? d).trim();

export type Plan = "free" | "pro" | "ultra" | "mega";
/** Published limits per plan (spec section 5): requests per day / per minute. */
export const PLAN_LIMITS: Record<Plan, { day: number; minute: number }> = {
  free: { day: 100, minute: 10 },
  pro: { day: 7500, minute: 300 },
  ultra: { day: 75000, minute: 450 },
  mega: { day: 150000, minute: 900 },
};

export const config = {
  get databaseUrl() {
    return env("DATABASE_URL", "postgres://farpost:farpost@localhost:5432/farpost");
  },
  get appUrl() {
    return env("APP_URL", "http://localhost:3000").replace(/\/$/, "");
  },
  get sessionSecret() {
    return env("SESSION_SECRET", "dev-only-secret");
  },
  get provider(): "mock" | "api-football" {
    return env("FOOTBALL_PROVIDER", "mock") === "api-football" ? "api-football" : "mock";
  },
  get apiFootball() {
    const plan = env("API_FOOTBALL_PLAN", "free") as Plan;
    return {
      key: env("API_FOOTBALL_KEY"),
      baseUrl: env("API_FOOTBALL_BASE_URL", "https://v3.football.api-sports.io"),
      leagueId: env("API_FOOTBALL_LEAGUE_ID", "39"),
      season: env("API_FOOTBALL_SEASON", "2026"),
      plan: PLAN_LIMITS[plan] ? plan : "free",
      batch: env("API_FOOTBALL_BATCH", "true") !== "false",
    };
  },
  get resendKey() {
    return env("RESEND_API_KEY");
  },
  get emailFrom() {
    return env("EMAIL_FROM", "Far Post <login@example.com>");
  },
  get adminEmails(): string[] {
    return env("ADMIN_EMAILS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  },
  get alertEmails(): string[] {
    const a = env("ALERT_EMAIL").split(",").map((s) => s.trim()).filter(Boolean);
    return a.length ? a : this.adminEmails;
  },
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
};
