// A logging reverse proxy for a real Strata server: forwards everything, and
// writes each /v1/chat/completions request body to a JSON-lines file so the
// wire format can be inspected.
//   node test/proxy.mjs <upstream> <port> <logfile>
import fs from "node:fs";
import http from "node:http";

const [upstream, portArg, logFile] = process.argv.slice(2);
if (!upstream || !portArg || !logFile) {
  console.error("usage: node test/proxy.mjs <upstream-url> <port> <logfile>");
  process.exit(2);
}

const target = new URL(upstream);
const log = fs.createWriteStream(logFile, { flags: "a" });

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.url?.includes("/chat/completions") && body.length > 0) {
      try {
        log.write(`${JSON.stringify({ at: new Date().toISOString(), url: req.url, body: JSON.parse(body.toString()) })}\n`);
      } catch {
        log.write(`${JSON.stringify({ at: new Date().toISOString(), url: req.url, raw: body.toString().slice(0, 2000) })}\n`);
      }
      log.write("\n---\n");
    }

    const forwarded = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    forwarded.on("error", (error) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    });
    if (body.length > 0) forwarded.write(body);
    forwarded.end();
  });
});

server.listen(Number(portArg), "127.0.0.1", () =>
  console.log(`proxy on http://127.0.0.1:${portArg} -> ${upstream}, logging to ${logFile}`),
);
