import { createServer } from "node:http";
import { processMediaTask } from "./tasks/process-media";

const port = Number(process.env.PORT || 0);

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "narriflow-worker" }));
    return;
  }

  if (req.url === "/task/demo" && req.method === "POST") {
    const response = await processMediaTask({
      projectId: crypto.randomUUID(),
      sourceMediaUrl: "https://example.com/media.mp4",
      outputs: ["short_clip"],
    });

    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, () => {
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  console.log(`narriflow worker listening on :${resolvedPort}`);
});
