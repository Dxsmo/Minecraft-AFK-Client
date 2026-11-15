import readline from "node:readline";
import { emit, type Config, type Command, type OutEvent } from "../bedrock-bot/protocol.js";
import { startMineflayer, type MineflayerSession } from "./session.js";

process.umask(0o077);

let session: MineflayerSession | undefined;
let exiting = false;
function exit(code: number): void {
  if (exiting) return;
  exiting = true;
  session?.stop();
  process.stdout.write("", () => process.exit(code));
  setTimeout(() => process.exit(code), 100).unref();
}
const fatal = (error: unknown) => { emit({ type: "fatal_error", error: error instanceof Error ? error.message : String(error) }); exit(1); };
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
process.on("SIGTERM", () => exit(0));
process.on("SIGINT", () => exit(0));
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  if (exiting || !line.trim()) return;
  try {
    if (!session) session = startMineflayer(JSON.parse(line) as Config, event => emit(event as OutEvent), exit);
    else session.command(JSON.parse(line) as Command);
  } catch (error) { fatal(error); }
});
input.on("close", () => exit(0));
