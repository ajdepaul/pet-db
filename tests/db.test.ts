import { createDbClient } from "../src/db.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { z } from "zod";
import type { DbVersionConfig, RestrictedData } from "../src/types.js";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

const v1InputSchema = z.object({ value: z.string().max(10) });
type V1Input = z.infer<typeof v1InputSchema>;
const v1OutputSchema = v1InputSchema.transform((d) => ({ ...d, valueWithExtra: `${d.value} +extra` }));
type V1Output = z.infer<typeof v1OutputSchema>;

const v1Config: DbVersionConfig<unknown, V1Input, V1Output> = {
  version: 1,
  inputSchema: v1InputSchema,
  outputSchema: v1OutputSchema,
  migrate: () => ({ value: "default" }),
};

describe("db", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("createDbClient", () => {
    it("readme snippet works correctly", async () => {
      vi.mocked(readFile).mockRejectedValue({ code: "ENOENT" });

      const v1InputSchema = z.object({ value: z.string().max(10) });
      const v1OutputSchema = v1InputSchema.transform((d) => ({ ...d, valueWithExtra: `${d.value} +extra` }));

      const v2InputSchema = z.object({ value: z.string(), num: z.number().int() });
      const v2OutputSchema = v2InputSchema.transform((d) => ({ ...d, numString: d.num.toString() }));

      const petDb = await createDbClient()
        .addVersion({
          version: 1,
          inputSchema: v1InputSchema,
          outputSchema: v1OutputSchema,
          migrate: () => ({ value: "default" }),
        })
        .addVersion({
          version: 2,
          inputSchema: v2InputSchema,
          outputSchema: v2OutputSchema,
          migrate: (old) => ({ value: old.value, num: 0 }),
        })
        .build("db.json");

      await petDb.mutate((draft) => {
        draft.value = "new value";
        draft.num = 123;
      });

      expect(writeFile).toHaveBeenCalledWith(
        "db.json",
        JSON.stringify({ version: 2, data: { value: "new value", num: 123 } }),
      );
      await expect(petDb.view()).resolves.toEqual({ value: "new value", num: 123, numString: "123" });
    });

    it("correctly migrates multiple versions from empty data", async () => {
      vi.mocked(readFile).mockRejectedValue({ code: "ENOENT" });

      const v2InputSchema = z.object({ value: z.string(), num: z.number().int() });
      const v2OutputSchema = v2InputSchema.transform((d) => ({ ...d, numString: d.num.toString() }));

      const dbClient = await createDbClient()
        .addVersion(v1Config)
        .addVersion({
          version: 2,
          inputSchema: v2InputSchema,
          outputSchema: v2OutputSchema,
          migrate: (oldData) => ({ ...oldData, num: 123 }),
        })
        .build("db.json");

      await expect(dbClient.view()).resolves.toEqual({ value: "default", num: 123, numString: "123" });
    });

    it("view() correctly lazy-loads data, validates output schema, and memoizes the result", async () => {
      const inputData = { value: "test" };
      const outputData = { ...inputData, valueWithExtra: "test +extra" };

      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ version: 1, data: inputData }));

      const dbClient = await createDbClient().addVersion(v1Config).build("db.json");

      // first call should load data
      const data1 = await dbClient.view();
      expect(data1).toEqual(outputData);
      expect(readFile).toHaveBeenCalledTimes(1);

      // second call should use memoized data
      const data2 = await dbClient.view();
      expect(data2).toEqual(outputData);
      expect(readFile).toHaveBeenCalledTimes(1); // not called again
    });

    it("build() throws an error if no version configurations are provided", async () => {
      await expect(createDbClient().build("db.json")).rejects.toThrow(/Missing DB version configurations/);
    });

    it("view() throws error when parsing file fails output schema", async () => {
      const badOutputConfig: DbVersionConfig<unknown, any, string> = {
        version: 1,
        inputSchema: z.any(),
        outputSchema: z.string(),
        migrate: () => "default",
      };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ version: 1, data: 123 }));
      const client = await createDbClient().addVersion(badOutputConfig).build("db.json");
      await expect(client.view()).rejects.toThrow(/Failed to parse DB file/);
    });

    it("mutate() modifies data, validates against inputSchema, writes to file system, and clears memo", async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ version: 1, data: { value: "test" } }));
      const client = await createDbClient().addVersion(v1Config).build("db.json");

      await client.view(); // populate memo

      await client.mutate((draft) => {
        draft.value = "mutated";
      });

      expect(writeFile).toHaveBeenCalledWith("db.json", JSON.stringify({ version: 1, data: { value: "mutated" } }));

      // view again should load from raw data (memo was cleared, but raw data was updated)
      const data = await client.view();
      expect(data).toEqual({ value: "mutated", valueWithExtra: "mutated +extra" });
      expect(readFile).toHaveBeenCalledTimes(1); // didnt read again because raw data was present
    });

    it("mutate() throws error when mutation fails inputSchema", async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ version: 1, data: { value: "test" } }));
      const client = await createDbClient().addVersion(v1Config).build("db.json");

      await expect(
        client.mutate((draft) => {
          draft.value = "this value is too long";
        }),
      ).rejects.toThrow(/DB mutation failed to pass schema validation/);

      expect(writeFile).not.toHaveBeenCalled();
    });

    it("mutate() throws error on write failure", async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ version: 1, data: { value: "test" } }));
      vi.mocked(writeFile).mockRejectedValue(new Error("Disk full"));

      const client = await createDbClient().addVersion(v1Config).build("db.json");

      await expect(
        client.mutate((draft) => {
          draft.value = "changed";
        }),
      ).rejects.toThrow(/Error writing to DB File/);
    });

    it("mutate() triggers backup if backupOptions is provided", async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ version: 1, data: { value: "test" } }));

      const mockBackupFunction = vi.fn();

      const client = await createDbClient().addVersion(v1Config).build("db.json", {
        backupFunction: mockBackupFunction,
        maxFiles: 3,
      });

      await client.mutate((draft) => {
        draft.value = "mutated";
      });

      expect(writeFile).toHaveBeenCalledWith("db.json", JSON.stringify({ version: 1, data: { value: "mutated" } }));

      expect(mockBackupFunction).toHaveBeenCalledTimes(1);
      expect(mockBackupFunction).toHaveBeenCalledWith("db.json", "mutate", {
        backupFunction: mockBackupFunction,
        maxFiles: 3,
      });
    });
  });
});
