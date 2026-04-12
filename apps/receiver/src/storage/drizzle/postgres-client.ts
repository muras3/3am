import postgres from "postgres";

export type SharedPostgresClient = ReturnType<typeof postgres>;

const DEFAULT_POSTGRES_POOL_MAX = 10;
const DEFAULT_POSTGRES_CONNECT_TIMEOUT_SECONDS = 10;

export function createPostgresClient(connectionString?: string): SharedPostgresClient {
  const url = connectionString ?? process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required for PostgresAdapter");
  return postgres(url, {
    max: DEFAULT_POSTGRES_POOL_MAX,
    prepare: false,
    connect_timeout: DEFAULT_POSTGRES_CONNECT_TIMEOUT_SECONDS,
  });
}
