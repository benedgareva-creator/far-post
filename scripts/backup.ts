// Writes a JSON backup of the whole game to backups/. Run: `npm run backup`.
import "./env";
import fs from "node:fs";
import path from "node:path";
import { pool } from "../src/lib/db";
import { exportBackup } from "../src/lib/services/admin";

exportBackup()
  .then((data) => {
    const dir = path.join(__dirname, "..", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `far-post-backup-${data.createdAt.slice(0, 19).replace(/:/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
    console.log(`Saved ${file}`);
    return pool().end();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
