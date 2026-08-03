import { startDaemon } from "./index.js";

const rootPath = process.argv[2];
if (!rootPath) {
  console.error("usage: main.js <workspace-root>");
  process.exit(2);
}

const handle = await startDaemon({ rootPath, onExit: () => process.exit(0) });

const stop = () => {
  handle.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
