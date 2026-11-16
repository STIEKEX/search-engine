import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// During development the React app runs on http://localhost:5173 and the
// API on http://localhost:3000. The proxy forwards /api/* to the API, so the
// browser sees one origin and no CORS setup is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
