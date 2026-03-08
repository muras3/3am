import { serve } from "@hono/node-server";
import { createApp } from "./index.js";

const port = Number(process.env.PORT ?? 4318);
const app = createApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`3amoncall receiver listening on http://localhost:${info.port}`);
});
