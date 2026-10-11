import dns from "node:dns";
import app from "./app.js";
import connectDb from "./config/db.js";

// Some networks (college/ISP DNS) refuse the SRV lookup that mongodb+srv://
// URIs need, giving "querySrv ECONNREFUSED". Public DNS servers avoid it.
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const PORT = Number(process.env.PORT) || 3000;
const { MONGODB_URI } = process.env;

if (!MONGODB_URI) {
  console.error("MONGODB_URI is not set. Add it to Backend/.env");
  process.exit(1);
}

// Connect first, then accept requests: no request should arrive before the DB is ready.
try {
  await connectDb(MONGODB_URI);
} catch (err) {
  console.error("Could not connect to MongoDB:", err.message);
  process.exit(1);
}

// Express 5 passes listen errors (e.g. EADDRINUSE: port already taken) to this callback.
app.listen(PORT, (err) => {
  if (err) {
    console.error(`Could not start server on port ${PORT}: ${err.code}`);
    process.exit(1);
  }
  console.log(`Server running on http://localhost:${PORT}`);
});
