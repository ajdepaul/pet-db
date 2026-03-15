import { readFile } from "fs/promises";
import { BaseDbFile, baseDbFileSchema, DbVersionConfig } from "./types.js";

export async function loadFile(dbPath: string, configs: DbVersionConfig<any, any, any>[]): Promise<BaseDbFile | null> {
  let rawText: string;
  try {
    rawText = await readFile(dbPath, "utf-8");
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT") {
      return null;
    } else if (e instanceof Error) {
      throw new Error(`Failed to read DB file ("${dbPath}").`, { cause: e });
    } else {
      throw new Error(`Failed to read DB file ("${dbPath}").`);
    }
  }

  let rawJson: any;
  try {
    rawJson = JSON.parse(rawText);
  } catch (e) {
    if (e instanceof Error) {
      throw new Error(`Failed to parse DB JSON ("${dbPath}").`, { cause: e });
    } else {
      throw new Error(`Failed to parse DB JSON ("${dbPath}").`);
    }
  }

  const parsedDbFile = baseDbFileSchema.strict().safeParse(rawJson);

  if (parsedDbFile.success) {
    const { version, data } = parsedDbFile.data;
    const config = configs.find((c) => c.version === version);

    if (!config) {
      throw new Error(
        `File DB version does not have a matching version configuration (found: ${version}, available: ${configs}).`,
      );
    }

    const parsedDbData = config.inputSchema.safeParse(data);

    if (!parsedDbData.success) {
      throw new Error("Loaded DB file does not match its schema.", { cause: parsedDbData.error });
    }

    return { version, data };
  } else {
    throw new Error("DB file failed base schema validation.");
  }
}

export function migrate(d: BaseDbFile | null, configs: DbVersionConfig<any, any, any>[]): BaseDbFile {
  let rawData = d;
  let firstConfigToApply = 0;

  if (d) {
    firstConfigToApply = configs.findIndex((c) => c.version === d.version) + 1;
    if (firstConfigToApply === 0) {
      throw new Error(
        `File DB version does not have a matching version configuration (found: ${d.version}, available: ${configs}).`,
      );
    }
  }

  for (let i = firstConfigToApply; i < configs.length; i++) {
    const config = configs[i]!;
    const newData = config.migrate(rawData?.data);

    const parsed = config.inputSchema.safeParse(newData);

    if (parsed.success) {
      rawData = { version: config.version, data: parsed.data };
    } else {
      throw new Error(`Migration to version ${config.version} failed validation.`);
    }
  }

  return rawData!;
}
