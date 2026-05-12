import { readFile, writeFile } from "fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadFile, migrate, writeData } from "../src/db-util.js";
import type { DbVersionConfig } from "../src/types.js";

vi.mock("fs/promises", () => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
}));

const v1InputSchema = z.object({ value: z.string().max(10) });
type V1Input = z.infer<typeof v1InputSchema>;
const v1OutputSchema = v1InputSchema.transform((d) => ({ ...d, valueWithExtra: `${d.value} +extra` }));
type V1Output = z.infer<typeof v1OutputSchema>;

const v2InputSchema = z.object({ value: z.string(), num: z.number().int() });
type V2Input = z.infer<typeof v2InputSchema>;
const v2OutputSchema = v2InputSchema.transform((d) => ({ ...d, numString: d.num.toString() }));
type V2Output = z.infer<typeof v2OutputSchema>;

const v1Config: DbVersionConfig<unknown, V1Input, V1Output> = {
  version: 1,
  inputSchema: v1InputSchema,
  outputSchema: v1OutputSchema,
  migrate: () => ({ value: "default" }),
};

const v2Config: DbVersionConfig<V1Input, V2Input, V2Output> = {
  version: 2,
  inputSchema: v2InputSchema,
  outputSchema: v2OutputSchema,
  migrate: (old) => ({ value: old.value, num: 0 }),
};

const allConfigs = [v1Config, v2Config];

describe("db-util", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("loadFile", () => {
    it("successfully returns { version, data } for a valid database file", async () => {
      const validDb = { version: 1, data: { value: "test" } };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(validDb));
      expect(await loadFile("db.json", allConfigs)).toEqual(validDb);
    });

    it("returns null when a file does not exist (ENOENT)", async () => {
      vi.mocked(readFile).mockRejectedValue({ code: "ENOENT" });
      const result = await loadFile("db.json", allConfigs);
      expect(result).toBeNull();
    });

    it("throws an error on invalid/malformed JSON", async () => {
      vi.mocked(readFile).mockResolvedValue("invalid json");
      await expect(loadFile("db.json", allConfigs)).rejects.toThrow(/Failed to parse DB JSON/);
    });

    it("throws an error when file version has no matching configuration", async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ version: 999, data: {} }));
      await expect(loadFile("db.json", allConfigs)).rejects.toThrow(
        /File DB version does not have a matching version configuration/,
      );
    });

    it("throws an error when the loaded DB file fails inputSchema validation", async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ version: 1, data: { value: 123 } })); // value should be string
      await expect(loadFile("db.json", allConfigs)).rejects.toThrow(/Loaded DB file does not match its schema/);
    });

    it("throws an error when DB file fails base schema validation", async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ version: 1.5, data: { value: "default" } })); // version should be int
      await expect(loadFile("db.json", allConfigs)).rejects.toThrow(/DB file failed base schema validation/);
    });

    it("throws an error on other read errors", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("Permission denied"));
      await expect(loadFile("db.json", allConfigs)).rejects.toThrow(/Failed to read DB file/);
    });
  });

  describe("migrate", () => {
    it("correctly migrates from null through multiple version configurations", async () => {
      const result = await migrate(null, allConfigs, "db.json");
      expect(result).toEqual({ version: 2, data: { value: "default", num: 0 } });
    });

    it("correctly migrates from an older version through the remaining configurations", async () => {
      const db = { version: 1, data: { value: "test" } };
      const result = await migrate(db, allConfigs, "db.json");
      expect(result).toEqual({ version: 2, data: { value: "test", num: 0 } });
    });

    it("throws an error if a target file version is not found in configurations", async () => {
      const db = { version: 999, data: {} };
      await expect(migrate(db, allConfigs, "db.json")).rejects.toThrow(
        /File DB version does not have a matching version configuration/,
      );
    });

    it("throws an error if the data produced by migrate fails the next version's inputSchema", async () => {
      const badV2Config: DbVersionConfig<V1Input, V2Input, V2Output> = {
        version: 2,
        inputSchema: v2InputSchema,
        outputSchema: v2OutputSchema,
        migrate: () => ({ value: "", num: 1.23 }), // num should be int
      };

      const db = { version: 1, data: { value: "test" } };
      await expect(migrate(db, [v1Config, badV2Config], "db.json")).rejects.toThrow(
        /Migration to version 2 failed validation/,
      );
    });
  });

  describe("writeData", () => {
    const mockBackupFunction = vi.fn();
    const mockDbData = { version: 1, data: { value: "test" } };

    beforeEach(() => {
      mockBackupFunction.mockClear();
    });

    it("writes data to the DB file using JSON.stringify", async () => {
      await writeData("test.json", mockDbData, "mutate");
      expect(vi.mocked(writeFile)).toHaveBeenCalledWith("test.json", JSON.stringify(mockDbData));
    });

    it("executes a custom backup function if provided in options", async () => {
      const options = { backupFunction: mockBackupFunction };
      await writeData("test.json", mockDbData, "mutate", options);

      expect(mockBackupFunction).toHaveBeenCalledWith("test.json", "mutate", options);
      expect(vi.mocked(writeFile)).toHaveBeenCalledWith("test.json", JSON.stringify(mockDbData));
    });

    it("throws an error if writeFile fails", async () => {
      vi.mocked(writeFile).mockRejectedValue(new Error("Disk space full"));
      await expect(writeData("test.json", mockDbData, "mutate")).rejects.toThrow(/Error writing to DB File/);
    });
  });
});
