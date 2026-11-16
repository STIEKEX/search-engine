// Throwaway MongoDB for tests: mongodb-memory-server starts a real mongod
// process with an empty database, so tests never touch your Atlas data and
// work offline (the binary is downloaded once, into node_modules/.cache).

import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
// Imported for their side effect: registering the models, so init() below
// builds their indexes. Several unique indexes are part of correctness.
import "../../server/models/Content.js";
import "../../server/models/CorpusStats.js";
import "../../server/models/Counter.js";
import "../../server/models/CrawlJob.js";
import "../../server/models/CrawlUrl.js";
import "../../server/models/Domain.js";
import "../../server/models/HostSlot.js";
import "../../server/models/IndexedDocument.js";
import "../../server/models/Page.js";
import "../../server/models/QueueMessage.js";
import "../../server/models/Term.js";

export async function startTestDb() {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri("crawler-test");
  await mongoose.connect(uri);
  // Build indexes now instead of in the background, so tests that rely on
  // them (unique URL per job, one message per URL) are not racing the build.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));

  return {
    uri,
    async clear() {
      await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
    },
    async stop() {
      await mongoose.disconnect();
      await mongod.stop();
    },
  };
}
