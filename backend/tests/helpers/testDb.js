// Throwaway MongoDB for tests: mongodb-memory-server starts a real mongod
// process with an empty database, so tests never touch your Atlas data and
// work offline (the binary is downloaded once, into node_modules/.cache).

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import Domain from "../../server/models/Domain.js";
import Page from "../../server/models/Page.js";

export async function startTestDb() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("crawler-test"));
  // Build indexes now (unique on normalizedUrl/origin) instead of in the background,
  // so tests that rely on them are not racing the index build.
  await Promise.all([Page.init(), Domain.init()]);

  return {
    async clear() {
      await Promise.all([Page.deleteMany({}), Domain.deleteMany({})]);
    },
    async stop() {
      await mongoose.disconnect();
      await mongod.stop();
    },
  };
}
