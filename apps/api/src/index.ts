import "dotenv/config";
import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const app = createApp();

try {
  await app.listen({ port, host });
  app.log.info(`AyaTopos API listening on http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
