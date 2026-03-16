import { Mutex } from "async-mutex";
import { loadFile, migrate, writeData } from "./db-util.js";
import type { BaseDbFile, DbClientBuilder, DbVersionConfig, RestrictedData } from "./types.js";

function createDbClientBuilder<DbInput extends RestrictedData, DbOutput>(
  configs: DbVersionConfig<any, any, any>[],
): DbClientBuilder<DbInput, DbOutput> {
  return {
    addVersion: (config) => createDbClientBuilder([...configs, config]),

    build: async (dbPath, backupOptions) => {
      if (configs.length === 0) throw new Error("Missing DB version configurations.");

      const finalConfig = configs.at(-1)!;

      let rawData: BaseDbFile | null = null;
      let dbOutputMemo: any = null;

      const mutex = new Mutex();

      const loadRawData = async () => {
        return await migrate(await loadFile(dbPath, configs), configs, dbPath, backupOptions);
      };

      return {
        view: async () => {
          return await mutex.runExclusive(async () => {
            if (!dbOutputMemo) {
              if (!rawData) rawData = await loadRawData();

              const parsed = finalConfig.outputSchema.safeParse(rawData.data);

              if (parsed.success) {
                dbOutputMemo = parsed.data;
              } else {
                throw new Error("Failed to parse DB file.", { cause: parsed.error });
              }
            }
            return dbOutputMemo;
          });
        },

        mutate: async (mutator) => {
          await mutex.runExclusive(async () => {
            if (!rawData) rawData = await loadRawData();

            const draft = structuredClone(rawData);
            mutator(draft.data);

            const parsed = finalConfig.inputSchema.safeParse(draft.data);
            if (!parsed.success) {
              throw new Error("DB mutation failed to pass schema validation.", { cause: parsed.error });
            }

            const newRawData = { version: finalConfig.version, data: parsed.data };
            await writeData(dbPath, newRawData, "mutate", backupOptions);
            rawData = newRawData;
            dbOutputMemo = null; // view memo is no longer valid
          });
        },
      };
    },
  };
}

export function createDbClient(): DbClientBuilder<{}, never> {
  return createDbClientBuilder([]);
}
