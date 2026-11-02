import { createServer } from "./server";
import { autoDiscoverZeroClaw } from "./zeroclaw-discovery";

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8765;
const server = createServer({ port });

console.log(`Gateway server listening on http://localhost:${server.port}`);

// Non-blocking auto-discovery of ZeroClaw gateway & pairing token
autoDiscoverZeroClaw()
  .then((nudge) => {
    if (nudge) {
      console.log(`[pi-api] ZeroClaw webhook auto-paired: ${nudge.gatewayUrl}`);
    }
  })
  .catch(() => {
    // ZeroClaw may not be running locally, safe to ignore
  });
