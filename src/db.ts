import type { BaseDbFile, DbClientBuilder, DbVersionConfig, RestrictedData } from "./types.js";
import { loadFile, migrate } from "./db-util.js";
import { writeFile } from "fs/promises";
import { Mutex } from "async-mutex";

function createDbClientBuilder<DbInput extends RestrictedData, DbOutput>(
  configs: DbVersionConfig<any, any, any>[],
): DbClientBuilder<DbInput, DbOutput> {
  return {
    addVersion: (config) => createDbClientBuilder([...configs, config]),

    build: (dbPath) => {
      if (configs.length === 0) {
        throw new Error("Missing DB version configurations.");
      }

      const finalConfig = configs.at(-1)!;

      let rawData: BaseDbFile | null = null;
      let dbOutputMemo: any = null;

      const loadRawData = async () => migrate(await loadFile(dbPath, configs), configs);

      const mutex = new Mutex();

      return {
        view: async () => {
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

            try {
              await writeFile(dbPath, JSON.stringify(newRawData));
            } catch (e) {
              if (e instanceof Error) {
                throw new Error("Error writing to DB File.", { cause: e });
              } else {
                throw new Error("Error writing to DB File.");
              }
            }

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
