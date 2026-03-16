import { access, copyFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBackup } from "../src/default-backup.js";

vi.mock("fs/promises", () => ({
  access: vi.fn(),
  copyFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
}));

describe("defaultBackup", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T12:00:00.000Z"));
    vi.resetAllMocks();

    vi.mocked(access).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(readdir).mockResolvedValue([]);
    vi.mocked(copyFile).mockResolvedValue(undefined);
    vi.mocked(unlink).mockResolvedValue(undefined);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleLogSpy.mockRestore();
  });

  it("returns early if db file does not exist", async () => {
    vi.mocked(access).mockRejectedValue(new Error("ENOENT"));

    await defaultBackup("test.json", "mutate", {});

    expect(access).toHaveBeenCalledWith("test.json");
    expect(mkdir).not.toHaveBeenCalled();
    expect(copyFile).not.toHaveBeenCalled();
  });

  it("creates backup directory if needed and performs initial backup", async () => {
    await defaultBackup("my-db.json", "mutate", {});

    expect(mkdir).toHaveBeenCalledWith("backups", { recursive: true });
    expect(readdir).toHaveBeenCalledWith("backups");

    expect(copyFile).toHaveBeenCalledWith(
      "my-db.json",
      expect.stringMatching(/backups[/\\]my-db_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/),
    );
  });

  it("throws error if mkdir fails", async () => {
    vi.mocked(mkdir).mockRejectedValue(new Error("EACCES"));
    await expect(defaultBackup("test.json", "mutate", {})).rejects.toThrow(/Failed to create backups directory/);
  });

  it("throws error if readdir fails", async () => {
    vi.mocked(readdir).mockRejectedValue(new Error("EACCES"));
    await expect(defaultBackup("test.json", "mutate", {})).rejects.toThrow(/Failed to scan backup directory/);
  });

  it("always backups on 'migrate' trigger even if recent backup exists", async () => {
    vi.mocked(readdir).mockResolvedValue(["my-db_old.json"] as any);
    vi.mocked(stat).mockResolvedValue({ mtimeMs: Date.now() - 1000 } as any); // 1 second ago

    await defaultBackup("my-db.json", "migrate", {});

    expect(copyFile).toHaveBeenCalled();
  });

  it("does not backup if 'mutate' trigger and recent backup exists", async () => {
    vi.mocked(readdir).mockResolvedValue(["my-db_old.json"] as any);
    vi.mocked(stat).mockResolvedValue({ mtimeMs: Date.now() - 1000 } as any); // 1 second ago

    await defaultBackup("my-db.json", "mutate", {});

    expect(copyFile).not.toHaveBeenCalled();
  });

  it("backs up if 'mutate' trigger but recent backup is older than interval", async () => {
    vi.mocked(readdir).mockResolvedValue(["my-db_old.json"] as any);

    // 24 hours and 1 second ago
    vi.mocked(stat).mockResolvedValue({ mtimeMs: Date.now() - 24 * 60 * 60 * 1000 - 1000 } as any);

    await defaultBackup("my-db.json", "mutate", {});

    expect(copyFile).toHaveBeenCalled();
  });

  it("respects custom backup interval from options", async () => {
    vi.mocked(readdir).mockResolvedValue(["my-db_old.json"] as any);

    // 2 hours ago
    vi.mocked(stat).mockResolvedValue({ mtimeMs: Date.now() - 2 * 60 * 60 * 1000 } as any);

    // custom interval: 1 hour (3600 seconds)
    await defaultBackup("my-db.json", "mutate", { interval: 3600 });

    expect(copyFile).toHaveBeenCalled();
  });

  it("deletes oldest backups if exceeding maxFiles", async () => {
    const existingFiles = Array.from({ length: 10 }, (_, i) => `backup_${i}.json`);
    vi.mocked(readdir).mockResolvedValue(existingFiles as any);

    // make them progressively newer, so backup_0.json is oldest
    vi.mocked(stat).mockImplementation(async (filePath) => {
      const match = filePath.toString().match(/(\d+)/);
      const index = match ? parseInt(match[1]!, 10) : 0;
      return { mtimeMs: Date.now() - 100000 + index * 1000 } as any;
    });

    await defaultBackup("my-db.json", "migrate", {}); // Force backup

    // 10 existing + 1 new = 11, delete extra 1 file
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith(join("backups", "backup_0.json"));
  });

  it("respects custom maxFiles and path options", async () => {
    const existingFiles = ["b1.json", "b2.json", "b3.json"];
    vi.mocked(readdir).mockResolvedValue(existingFiles as any);

    vi.mocked(stat).mockImplementation(async (filePath) => {
      const match = filePath.toString().match(/(\d+)/);
      const index = match ? parseInt(match[1]!, 10) : 0;
      return { mtimeMs: Date.now() - 100000 + index * 1000 } as any;
    });

    await defaultBackup("my-db.json", "migrate", { path: "custom_backups", maxFiles: 2 });

    expect(mkdir).toHaveBeenCalledWith("custom_backups", { recursive: true });

    // 3 existing + 1 new = 4 total, delete 2 extra files
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledWith(join("custom_backups", "b1.json"));
    expect(unlink).toHaveBeenCalledWith(join("custom_backups", "b2.json"));
  });

  it("throws error if copyFile fails", async () => {
    vi.mocked(copyFile).mockRejectedValue(new Error("DISK FULL"));
    await expect(defaultBackup("test.json", "migrate", {})).rejects.toThrow(/Backup error copying database/);
  });

  it("ignores non-json files in the backup directory", async () => {
    vi.mocked(readdir).mockResolvedValue(["not-a-backup.txt", "my-db_old.json"] as any);
    vi.mocked(stat).mockResolvedValue({ mtimeMs: Date.now() - 1000 } as any);

    // 1 sec old json, non-json ignored means no backup because the found json file is recent
    await defaultBackup("my-db.json", "mutate", {});

    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith(join("backups", "my-db_old.json"));
    expect(copyFile).not.toHaveBeenCalled();
  });

  it("logs success message on mutate if log option is true", async () => {
    await defaultBackup("my-db.json", "mutate", { log: true });
    expect(consoleLogSpy).toHaveBeenCalledWith("✅ Pet-DB routine backup complete.");
  });

  it("logs success message on migrate if log option is true", async () => {
    await defaultBackup("my-db.json", "migrate", { log: true });
    expect(consoleLogSpy).toHaveBeenCalledWith("✅ Pet-DB pre-migration backup complete.");
  });

  it("does not log if log option is omitted or false", async () => {
    await defaultBackup("my-db.json", "mutate", {});
    await defaultBackup("my-db.json", "migrate", { log: false });
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
