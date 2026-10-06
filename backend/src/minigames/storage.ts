import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config/config.js";

// API tests have an isolated DB and must also isolate temporary photos from production.
export const photoRoot =
  config.nodeEnv === "test"
    ? path.join(
        config.dataDir,
        "minigame-photos-test",
        createHash("sha256")
          .update(config.databaseUrl)
          .digest("hex")
          .slice(0, 12),
      )
    : path.join(config.dataDir, "minigame-photos");
