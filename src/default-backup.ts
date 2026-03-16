import { access, copyFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { dirname, join, parse } from "path";
import { BackupFunction, BackupOptions, BackupTrigger } from "./types.js";

export const defaultBackup: BackupFunction = async (
  dbPath: string,
  trigger: BackupTrigger,
  backupOptions: BackupOptions,
) => {
  // default backup options
  const backupsPath = backupOptions.path ?? join(dirname(dbPath), "backups");
  const backupInterval = backupOptions.interval ? backupOptions.interval * 1_000 : 24 * 60 * 60 * 1_000; // 24 hour default
  const maxBackups = backupOptions.maxFiles ?? 10;
  const log = backupOptions.log ?? false;

  try {
    await access(dbPath);
  } catch {
    return;
  }

  try {
    await mkdir(backupsPath, { recursive: true });
  } catch (e) {
    throw new Error("Failed to create backups directory.", { cause: e });
  }

  let jsonFiles: string[] = [];
  try {
    jsonFiles = (await readdir(backupsPath)).filter((f) => f.endsWith(".json"));
  } catch (e) {
    throw new Error(`Failed to scan backup directory ("${backupsPath}").`, { cause: e });
  }

  const filesWithStats = (
    await Promise.all(
      jsonFiles.map(async (file) => {
        try {
          return { file, stats: await stat(join(backupsPath, file)) };
        } catch (e) {
          throw new Error(`Failed to read file stats of file "${file}".`, { cause: e });
        }
      }),
    )
  ).sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs);

  if (
    trigger === "migrate" || // always backup on migrations
    jsonFiles.length === 0 || // always backup when none exist
    Date.now() - filesWithStats.at(-1)!.stats.mtimeMs > backupInterval // backup if it's been longer than `backupInterval` seconds
  ) {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const dateString = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

    const parsedPath = parse(dbPath);
    const backupFileName = `${parsedPath.name}_${dateString}${parsedPath.ext}`;
    const backupFilePath = join(backupsPath, backupFileName);

    try {
      await copyFile(dbPath, backupFilePath);
      if (log) {
        if (trigger === "mutate") console.log("✅ Pet-DB routine backup complete.");
        else if (trigger === "migrate") console.log("✅ Pet-DB pre-migration backup complete.");
      }
    } catch (e) {
      throw new Error(`Backup error copying database json file (${dbPath} to ${backupFilePath}).`, { cause: e });
    }

    const numToDelete = filesWithStats.length - maxBackups + 1; // +1 to account for the new backup not in filesWithStats

    for (let i = 0; i < numToDelete; i++) {
      try {
        await unlink(join(backupsPath, filesWithStats[i]!.file));
      } catch {
        console.warn(`Failed to delete backup file during cleanup (${filesWithStats[i]!.file}). Skipping...`);
      }
    }
  }
};
