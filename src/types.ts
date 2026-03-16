import { z } from "zod";

export type RestrictedData = Record<string, unknown> | unknown[];

export type DbClient<DbInput extends RestrictedData, DbOutput> = {
  view: () => Promise<DbOutput>;
  mutate: (mutator: (prevData: DbInput) => void) => Promise<void>;
};

export type DbVersionConfig<PrevDbInput, DbInput extends RestrictedData, DbOutput> = {
  version: number;
  inputSchema: z.ZodType<DbInput>;
  outputSchema: z.ZodType<DbOutput>;
  migrate: (oldData: PrevDbInput) => NoInfer<DbInput>;
};

export type BackupOptions = {
  path?: string;
  /**
   * The minimum interval (in seconds) that must pass between automatic backups.
   * If not specified, it defaults to 86,400 seconds (24 hours).
   */
  interval?: number;
  maxFiles?: number;
  log?: boolean;
  backupFunction?: BackupFunction;
};

export type BackupTrigger = "mutate" | "migrate";
export type BackupFunction = (dbPath: string, trigger: BackupTrigger, backupOptions: BackupOptions) => Promise<void>;

export type DbClientBuilder<DbInput extends RestrictedData, DbOutput> = {
  addVersion: <NextDbInput extends RestrictedData, NextDbOutput>(
    config: DbVersionConfig<DbInput, NextDbInput, NextDbOutput>,
  ) => DbClientBuilder<NextDbInput, NextDbOutput>;
  build: (dbPath: string, backupOptions?: BackupOptions) => Promise<DbClient<DbInput, DbOutput>>;
};

export const baseDbFileSchema = z.object({
  version: z.int(),
  data: z.any(),
});

export type BaseDbFile = z.infer<typeof baseDbFileSchema>;
