import assert from "node:assert/strict";
import http2 from "node:http2";
import { once } from "node:events";

const proxy = await import("../dist/proxy.js");
const backend = http2.createServer();
let receivedPath;
let receivedBody = Buffer.alloc(0);

backend.on("stream", (stream, headers) => {
  receivedPath = headers[":path"];
  stream.respond({ ":status": 200, "content-type": "application/proto" });
  stream.on("data", (chunk) => {
    receivedBody = Buffer.concat([receivedBody, Buffer.from(chunk)]);
  });
  stream.on("end", () => stream.end(Buffer.from([9, 8, 7])));
});

backend.listen(0, "127.0.0.1");
await once(backend, "listening");
const address = backend.address();
assert(address && typeof address !== "string");

try {
  const port = await proxy.startProxy(
    async () => "test-token",
    [{ id: "default", name: "Auto" }],
  );
  const modelsResponse = await fetch(`http://localhost:${port}/v1/models`);
  assert.equal(modelsResponse.status, 200);
  assert.deepEqual(await modelsResponse.json(), {
    object: "list",
    data: [
      {
        id: "default",
        object: "model",
        created: 0,
        owned_by: "cursor",
      },
    ],
  });

  const invalidResponse = await fetch(
    `http://localhost:${port}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "default", messages: [] }),
    },
  );
  assert.equal(invalidResponse.status, 400);

  const rpcResponse = await proxy.callCursorUnaryRpc({
    accessToken: "test-token",
    rpcPath: "/test.Unary/Call",
    requestBody: new Uint8Array([1, 2, 3]),
    url: `http://127.0.0.1:${address.port}`,
  });
  assert.equal(rpcResponse.timedOut, false);
  assert.equal(rpcResponse.exitCode, 0);
  assert.deepEqual([...rpcResponse.body], [9, 8, 7]);
  assert.equal(receivedPath, "/test.Unary/Call");
  assert.deepEqual([...receivedBody], [1, 2, 3]);

  console.log("✓ Node runtime proxy and HTTP/2 bridge passed");
} finally {
  proxy.stopProxy();
  await new Promise((resolve, reject) => {
    backend.close((error) => (error ? reject(error) : resolve()));
  });
}
